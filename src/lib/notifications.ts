import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  getDb,
  notificationDeliveries,
  notifications,
  users,
  agencyMemberships,
  type Database,
} from "@/db";
import { DomainError, auditIn, insertIgnoreReturningId, affectedRows } from "@/lib/ops";
import { getSettingIn } from "@/lib/config-service";
import { emailTransportAvailable, getEmailTransport } from "@/lib/email-transport";

type Q = any;

/* ============================================================
 * Notifications + transactional outbox (Phase 3 foundation, wired to
 * every later module).
 *
 * Rules that make this trustworthy:
 *   • The notification row and its delivery intents are inserted in the
 *     CALLER'S transaction. A business event and its notification therefore
 *     commit or roll back together — no orphaned emails, no silent gaps.
 *   • `dedupeKey` + a partial unique index mean an event that is replayed
 *     (retry, double click, webhook redelivery) produces ONE notification.
 *   • Recipients are resolved from membership rows server-side. The client
 *     can never name a recipient of someone else's tenant.
 *   • Delivery is only QUEUED when an email transport is actually
 *     configured. Without one, intents are recorded as SKIPPED with a reason,
 *     so nobody mistakes "queued forever" for "delivered".
 * ============================================================ */

export type NotificationSeverity = "INFO" | "ACTION_REQUIRED" | "WARNING" | "SUCCESS";

export interface NotifyInput {
  applicationId?: string | null;
  /** exactly one audience selector: explicit users, or the whole agency, or staff */
  userIds?: string[];
  agencyId?: string | null;
  staffOnly?: boolean;
  audienceRole?: string;
  kind: string;
  title: string;
  body: string;
  link?: string | null;
  severity?: NotificationSeverity;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  /** EMAIL creates a delivery intent; IN_APP is read-state only. */
  email?: { templateCode?: string; subject?: string; body?: string; to?: string[] } | null;
  /** idempotency for the delivery intent itself (defaults to dedupeKey + channel) */
  deliveryIdempotencyKey?: string | null;
}

export interface NotifyResult {
  notificationId: string;
  deduped: boolean;
  recipients: number;
  deliveriesQueued: number;
  deliveriesSkipped: number;
}

/** Staff mailboxes are addressed by role, not by hardcoded email. */
async function resolveRecipients(t: Q, input: NotifyInput): Promise<Array<{ id: string; email: string }>> {
  if (input.userIds?.length) {
    const rows = (await t
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(inArray(users.id, input.userIds), eq(users.isActive, true)))) as Array<{
      id: string;
      email: string;
    }>;
    return rows;
  }
  const conds: unknown[] = [eq(users.isActive, true)];
  if (input.staffOnly) {
    conds.push(inArray(users.role, ["SUPER_ADMIN", "ADMIN", "VISA_AGENT", "ACCOUNTING"]));
    const rows = (await t
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(and(...(conds as never[])))) as Array<{ id: string; email: string; role: string }>;
    // An audienceRole narrows a staff broadcast. Without this, every document
    // upload would notify the whole company instead of the desk that works it.
    const scoped = input.audienceRole ? rows.filter((r) => r.role === input.audienceRole) : rows;
    return scoped.map((r) => ({ id: r.id, email: r.email }));
  }
  if (input.agencyId) {
    const rows = (await t
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .innerJoin(agencyMemberships, eq(agencyMemberships.userId, users.id))
      .where(and(eq(agencyMemberships.agencyId, input.agencyId), eq(users.isActive, true)))) as Array<{
      id: string;
      email: string;
      role: string;
    }>;
    const scoped = input.audienceRole ? rows.filter((r) => r.role === input.audienceRole) : rows;
    return scoped.map((r) => ({ id: r.id, email: r.email }));
  }
  return [];
}

/** Whether an intent can actually be dispatched in this environment. */
export function emailTransportConfigured(): boolean {
  return emailTransportAvailable();
}

export async function notify(input: NotifyInput, tx?: Database): Promise<NotifyResult> {
  const t: Q = tx ?? (await getDb());
  if (!input.title || !input.body) throw new DomainError("VALIDATION", "notification requires title and body");

  const recipients = await resolveRecipients(t, input);
  if (!recipients.length) {
    // No audience is not an error — but it is recorded, so a silently
    // mis-routed notification is diagnosable rather than invisible.
    return { notificationId: "", deduped: false, recipients: 0, deliveriesQueued: 0, deliveriesSkipped: 0 };
  }

  const notificationsEnabled = await getSettingIn<boolean>(t, "notifications.enabled", true);
  const transport = emailTransportAvailable();
  let queued = 0;
  let skipped = 0;
  let firstId = "";
  let anyDeduped = false;

  for (const r of recipients) {
    const dedupeKey = input.dedupeKey ? `${input.dedupeKey}:${r.id}` : null;
    const inserted = (await t
      .insert(notifications)
      .values({
        agencyId: input.agencyId ?? null,
        userId: r.id,
        staffOnly: input.staffOnly ?? false,
        audienceRole: input.audienceRole ?? null,
        applicationId: input.applicationId ?? null,
        kind: input.kind,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 4000),
        link: input.link ?? null,
        severity: input.severity ?? "INFO",
        payload: input.payload ?? null,
        dedupeKey,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id })) as Array<{ id: string }>;

    if (!inserted.length) {
      anyDeduped = true;
      // Only a deduped insert can miss; that requires a key to have been set.
      if (!dedupeKey) continue;
      const existing = (await t
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.dedupeKey, dedupeKey))
        .limit(1)) as Array<{ id: string }>;
      if (!existing[0]) continue;
      firstId = firstId || existing[0].id;
      continue;
    }
    const notificationId = inserted[0]!.id;
    firstId = firstId || notificationId;

    if (input.email && notificationsEnabled !== false) {
      const idem = (input.deliveryIdempotencyKey ?? input.dedupeKey)
        ? `${input.deliveryIdempotencyKey ?? input.dedupeKey}:EMAIL:${r.id}`
        : null;
      const { inserted: didInsert } = await insertIgnoreReturningId(
        t,
        notificationDeliveries,
        {
          notificationId,
          channel: "EMAIL",
          to: input.email.to?.[0] ?? r.email,
          templateCode: input.email.templateCode ?? null,
          subject: input.email.subject?.slice(0, 500) ?? input.title.slice(0, 200),
          body: input.email.body ?? input.body,
          state: transport ? "QUEUED" : "SKIPPED",
          idempotencyKey: idem,
          lastErrorCode: transport ? null : "NO_TRANSPORT",
        },
        idem ? [{ column: notificationDeliveries.idempotencyKey, value: idem }] : undefined,
      );
      if (didInsert) {
        if (transport) queued++;
        else skipped++;
      }
    }
  }

  if (tx && firstId) {
    await auditIn(tx, {
      actor: null,
      action: "SEND",
      entityType: "notification",
      entityId: firstId,
      agencyId: input.agencyId ?? null,
      metadata: { kind: input.kind, recipients: recipients.length, queued, skipped, deduped: anyDeduped },
    });
  }

  return {
    notificationId: firstId,
    deduped: anyDeduped,
    recipients: recipients.length,
    deliveriesQueued: queued,
    deliveriesSkipped: skipped,
  };
}

/* ---------------- unread counts ---------------- */

export async function unreadCounts(userId: string): Promise<{ total: number; actionRequired: number }> {
  const t: Q = await getDb();
  const rows = (await t
    .select({ severity: notifications.severity })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), sql`${notifications.readAt} is null`))) as Array<{
    severity: string;
  }>;
  return {
    total: rows.length,
    actionRequired: rows.filter((r) => r.severity === "ACTION_REQUIRED" || r.severity === "WARNING").length,
  };
}

export async function markNotificationRead(input: {
  id: string;
  userId: string;
  agencyIds: string[];
}): Promise<boolean> {
  const t: Q = await getDb();
  // Ownership is re-proved here, not assumed from the route.
  const scope = input.agencyIds.length ? inArray(notifications.agencyId, input.agencyIds) : undefined;
  const res = await t
    .update(notifications)
    .set({ readAt: new Date(), readBy: input.userId })
    .where(
      and(
        eq(notifications.id, input.id),
        sql`${notifications.readAt} is null`,
        scope
          ? sql`(${notifications.userId} = ${input.userId} or ${notifications.agencyId} in (${sql.join(
              input.agencyIds.map((a) => sql`${a}`),
              sql`,`,
            )}))`
          : eq(notifications.userId, input.userId),
      ) as never,
    );
  return affectedRows(res) === 1;
}

/* ---------------- inbox queries ---------------- */

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  severity: string;
  readAt: string | null;
  createdAt: string;
  applicationId: string | null;
  reference: string | null;
}

/**
 * A user's inbox: their own direct notifications plus the agency-wide ones for
 * agencies they actually belong to. `agencyIds` comes from the session, and a
 * user with no membership sees only their personal rows — de-linking an account
 * from a tenant immediately stops the old tenant's traffic arriving.
 */
export async function listNotificationsForUser(
  user: { id: string; agencyIds: string[] },
  opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
): Promise<{ rows: NotificationView[]; total: number }> {
  const t: Q = await getDb();
  const { visaApplications } = await import("@/db");
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const offset = Math.max(0, opts.offset ?? 0);
  const tenantScope = user.agencyIds.length
    ? sql`(${notifications.userId} = ${user.id} or (${notifications.agencyId} is not null and ${notifications.agencyId} in (${sql.join(
        user.agencyIds.map((a) => sql`${a}`),
        sql`,`,
      )})))`
    : sql`${notifications.userId} = ${user.id}`;
  const conds: unknown[] = [tenantScope];
  if (opts.unreadOnly) conds.push(sql`${notifications.readAt} is null`);
  const rows = (await t
    .select({
      id: notifications.id,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      link: notifications.link,
      severity: notifications.severity,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      applicationId: notifications.applicationId,
      reference: visaApplications.reference,
    })
    .from(notifications)
    .leftJoin(visaApplications, eq(visaApplications.id, notifications.applicationId))
    .where(and(...(conds as never[])))
    .orderBy(sql`${notifications.createdAt} desc`)
    .limit(limit)
    .offset(offset)) as unknown as Array<Record<string, any>>;
  const countRow = (await t
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(...(conds as never[])))) as Array<{ n: number }>;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link ?? null,
      severity: r.severity,
      readAt: r.readAt ? String(r.readAt) : null,
      createdAt: String(r.createdAt),
      applicationId: r.applicationId ?? null,
      reference: r.reference ?? null,
    })),
    total: Number(countRow[0]?.n ?? 0),
  };
}

/** Bulk read-state update — same scoping rule as the list. */
export async function markAllRead(user: { id: string; agencyIds: string[] }): Promise<number> {
  const t: Q = await getDb();
  const scope = user.agencyIds.length
    ? sql`(${notifications.userId} = ${user.id} or ${notifications.agencyId} in (${sql.join(
        user.agencyIds.map((a) => sql`${a}`),
        sql`,`,
      )}))`
    : sql`${notifications.userId} = ${user.id}`;
  const res = await t
    .update(notifications)
    .set({ readAt: new Date(), readBy: user.id })
    .where(and(scope, sql`${notifications.readAt} is null`));
  return affectedRows(res);
}

/* ---------------- outbox drain ---------------- */

export interface DrainedDelivery {
  id: string;
  to: string | null;
  subject: string | null;
  body: string | null;
}

/**
 * Atomically claim up to `limit` due EMAIL deliveries (FOR UPDATE SKIP LOCKED)
 * and hand them to the transport callback. A delivery that is already being
 * processed by another worker is skipped, never double-sent.
 *
 * State machine: QUEUED → (SENT | FAILED). FAILED retries with exponential
 * backoff until max_attempts, then stays FAILED for operator attention.
 */
export async function drainOutbox(opts: {
  limit?: number;
  now?: Date;
  send?: (d: DrainedDelivery) => Promise<{ ok: boolean; providerMessageId?: string; error?: string }>;
}): Promise<{ claimed: number; sent: number; failed: number }> {
  const t: Q = await getDb();
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
  const now = opts.now ?? new Date();
  const transport = opts.send ? null : getEmailTransport();
  const send =
    opts.send ??
    (async (d: DrainedDelivery) =>
      transport
        ? transport.send({ to: d.to ?? "", subject: d.subject ?? "(no subject)", body: d.body ?? "" })
        : { ok: false, error: "NO_SENDER" });
  /*
   * Claim and hand out the rows in ONE statement.
   *
   * This used to be `SELECT … FOR UPDATE SKIP LOCKED` followed by a separate
   * UPDATE. Under a pooled driver each of those is its own transaction, so the row
   * lock died with the SELECT: two schedulers could both read the same QUEUED rows,
   * both send, and the second write simply overwrote the first — duplicate email to
   * a customer. Now the claim is atomic: the rows are taken (SKIP LOCKED) and pushed
   * out of the due set in the same UPDATE, and RETURNING hands them to exactly one
   * caller. `attempts` and the backoff window are the ticket; a crash before sending
   * just means the row becomes due again later, which is the intended at-least-once
   * semantic with the idempotency key preventing a second visible send.
   */
  const claimedRows = (
    await t.execute(sql`
      update "notification_deliveries" d
         set attempts = d.attempts + 1,
             next_attempt_at = (${now}::timestamptz + make_interval(secs => least(3600, (30 * power(2, d.attempts + 1))::int))),
             last_error_code = null,
             updated_at = ${now}::timestamptz
       where d.id in (
         select id
           from "notification_deliveries"
          where state = 'QUEUED'
            -- +1 ms: next_attempt_at defaults to the database now(), which carries
            -- microseconds, while the bound timestamp here is a JS Date truncated to
            -- milliseconds. Without the tolerance a row scheduled immediately can be up
            -- to 1 ms in the future and silently skipped by a drain running in the same
            -- millisecond — an admin pressing "send now" would be told there was nothing
            -- to send. Backoff windows are 30 s or more, so this absorbs only the
            -- rounding, never a real schedule.
            and next_attempt_at <= ${now}::timestamptz + interval '1 millisecond'
          order by next_attempt_at
          limit ${limit}
          for update skip locked
       )
       returning d.id as id, d.to as "to", d.subject as subject, d.body as body, d.attempts as attempts, d.max_attempts as "maxAttempts"
    `)
  ).rows as unknown as Array<{
    id: string;
    to: string | null;
    subject: string | null;
    body: string | null;
    attempts: number;
    maxAttempts: number;
  }>;

  let claimed = claimedRows.length;
  let sent = 0;
  let failed = 0;

  for (const row of claimedRows) {
    try {
      const res = await send({ id: row.id, to: row.to, subject: row.subject, body: row.body });
      if (res.ok) {
        sent++;
        await t
          .update(notificationDeliveries)
          .set({
            state: "SENT",
            sentAt: new Date(),
            providerMessageId: res.providerMessageId ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(notificationDeliveries.id, row.id), sql`${notificationDeliveries.attempts} = ${row.attempts}`));
      } else {
        throw new Error(res.error ?? "transport rejected");
      }
    } catch (err) {
      failed++;
      const exhausted = row.attempts >= row.maxAttempts;
      await t
        .update(notificationDeliveries)
        .set({
          state: exhausted ? "FAILED" : "QUEUED",
          lastErrorCode: String((err as Error).message).slice(0, 200),
          lastErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(notificationDeliveries.id, row.id));
    }
  }
  return { claimed, sent, failed };
}

/** Delivery statistics for the admin overview — honest about SKIPPED. */
export async function deliveryStats(): Promise<Record<string, number>> {
  const t: Q = await getDb();
  const rows = (await t
    .select({ state: notificationDeliveries.state, n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .groupBy(notificationDeliveries.state)) as Array<{ state: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = Number(r.n);
  return out;
}

/** Convenience wrapper used by the dispatcher script and by automation. */
export async function dispatchDueEmails(limit = 25): Promise<{ claimed: number; sent: number; failed: number }> {
  return drainOutbox({ limit });
}
