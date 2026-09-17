import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import crypto from "node:crypto";
import {
  agencyMemberships,
  agencies,
  applicationDocuments,
  communications,
  documentTypes,
  getDb,
  gmailAttachments,
  gmailConnections,
  gmailMessages,
  users,
  visaApplications,
  type Database,
} from "@/db";
import { assertActorPermission, DomainError, affectedRows, auditIn } from "@/lib/ops";
import { withTx } from "@/lib/with-tx";
import { getSettingIn } from "@/lib/config-service";
import { notify } from "@/lib/notifications";
import { getGmailProvider, gmailProviderAvailable, resolveGmailProviderName, type RawGmailMessage } from "@/lib/gmail-provider";
import { oauthState, openSealed, sealPlaintext, tokenKeyConfigured } from "@/lib/crypto-box";
import type { OpActor } from "@/lib/guard";
import { can } from "@/lib/rbac";

type Q = any;

/* ============================================================
 * Gmail intake (Phase 8).
 *
 * Principles, all enforced in code below:
 *
 * 1. Email is UNTRUSTED INPUT. It can classify and suggest. It can never
 *    configure: nothing here writes a fee, a status, a requirement or a
 *    business flag from message text.
 * 2. Attachment import is STAGED. A message never becomes a document on an
 *    application until a staff member links it, and linking runs the normal
 *    upload pipeline (tenant proof, sniffing, checklist rules, audit, event).
 * 3. Idempotent by construction: a re-sync of the same message id does nothing;
 *    the same attachment cannot be linked twice; drafts are recorded once.
 * 4. Credentials are references and sealed ciphertext. Client id/secret and the
 *    signing key come from named env vars; the refresh token is stored AES-GCM
 *    sealed and is never returned by any read path.
 * 5. No auto-send. The platform composes a DRAFT in the mailbox; a human sends.
 *
 * VERIFICATION: the ingest → classify → match → stage → link pipeline is fully
 * exercised against the fixture provider in tests. The Google REST adapter is
 * implemented to the documented API but is NOT verified against live Gmail in
 * this environment (no credentials, no outbound access).
 * ============================================================ */

export interface ConnectionView {
  id: string;
  label: string;
  emailAddress: string | null;
  status: string;
  provider: string;
  scopes: string[];
  lastSyncAt: string | null;
  lastError: string | null;
  tokenStored: boolean;
  canConnect: boolean;
}

export async function listConnections(actor?: OpActor): Promise<ConnectionView[]> {
  if (actor) assertActorPermission(actor, "gmail.connect");
  const t: Q = await getDb();
  const rows = (await t
    .select()
    .from(gmailConnections)
    .orderBy(asc(gmailConnections.label))) as Array<typeof gmailConnections.$inferSelect>;
  const provider = gmailProviderAvailable() ? resolveGmailProviderName() : "none";
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    emailAddress: r.emailAddress,
    status: r.status,
    provider,
    scopes: (r.scopes ?? []) as string[],
    lastSyncAt: r.lastSyncAt ? String(r.lastSyncAt) : null,
    lastError: r.lastError ?? null,
    tokenStored: Boolean(r.refreshTokenCipher),
    canConnect: provider !== "none" && tokenKeyConfigured(),
  }));
}

export async function createConnection(actor: { id: string; email: string; role: string }, label: string, emailAddress: string): Promise<string> {
  assertActorPermission(actor, "gmail.manage");
  const clean = label.trim();
  if (clean.length < 2) throw new DomainError("VALIDATION", "Give the connection a recognisable label");
  const email = emailAddress.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new DomainError("VALIDATION", "Enter the mailbox address being connected");
  const t: Q = await getDb();
  const clash = await t.select({ id: gmailConnections.id }).from(gmailConnections).where(sql`lower(${gmailConnections.emailAddress}) = lower(${email})`).limit(1);
  if (clash.length) throw new DomainError("DUPLICATE", "That mailbox is already registered");
  const e = (await import("@/lib/env")).env() as unknown as Record<string, string | undefined>;
  const inserted = (await t
    .insert(gmailConnections)
    .values({
      label: clean.slice(0, 80),
      emailAddress: email,
      status: "DISCONNECTED",
      scopes: [],
      clientIdRef: e["GMAIL_CLIENT_ID_REF"] ?? null,
      clientSecretRef: e["GMAIL_CLIENT_SECRET_REF"] ?? null,
      redirectUri: e["GMAIL_REDIRECT_URI"] ?? null,
      createdBy: actor.id,
    })
    .returning({ id: gmailConnections.id })) as Array<{ id: string }>;
  const id = inserted[0]!.id;
  await auditIn(t as unknown as Database, {
    actor,
    action: "CREATE",
    entityType: "gmail_connection",
    entityId: id,
    // label + address only — no client id, no secret, no token material
    metadata: { label: clean, emailAddress: email },
  });
  return id;
}

/** Step 1: where to send the admin. The state is signed so the callback can be
 *  proved to belong to this browser (and to this connection). */
export async function beginConnect(actor: { id: string; email: string; role: string }, connectionId: string): Promise<{ url: string; state: string; verifier: string }> {
  if (!can(actor.role as never, "gmail.connect")) throw new DomainError("FORBIDDEN", "You may not start a Gmail connection");
  const providerName = resolveGmailProviderName();
  if (providerName === "none") {
    throw new DomainError("CONFIG", "No Gmail provider configured (set GMAIL_PROVIDER=google, or =fixture for local testing)");
  }
  if (!tokenKeyConfigured()) {
    throw new DomainError("CONFIG", "Set ESF_TOKEN_KEY (base64 of 32 random bytes) before connecting a mailbox — tokens cannot be stored unencrypted");
  }
  const t: Q = await getDb();
  const rows = (await t.select().from(gmailConnections).where(eq(gmailConnections.id, connectionId)).limit(1)) as Array<typeof gmailConnections.$inferSelect>;
  const conn = rows[0];
  if (!conn) throw new DomainError("NOT_FOUND", "Connection not found");
  const e = (await import("@/lib/env")).env() as unknown as Record<string, string | undefined>;
  const clientId = conn.clientIdRef ? process.env[conn.clientIdRef] ?? null : null;
  const redirect = conn.redirectUri ?? null;
  if (providerName === "google" && (!clientId || !redirect)) {
    throw new DomainError("CONFIG", "GMAIL_CLIENT_ID_REF and GMAIL_REDIRECT_URI must point at a configured OAuth client");
  }
  const { state, verifier } = oauthState();
  const url = getGmailProvider().authorizeUrl({
    clientId: clientId ?? "fixture-client",
    redirectUri: redirect ?? "http://localhost:3000/api/gmail/callback",
    state,
    codeVerifier: verifier,
  });
  return { url, state, verifier };
}

/** Step 2: the redirect handler. Exchanges the code, seals the refresh token. */
export async function completeConnect(input: {
  connectionId: string;
  code: string;
  state: string;
  verifier: string;
  actor: { id: string; email: string; role: string };
}): Promise<{ emailAddress: string | null }> {
  if (!can(input.actor.role as never, "gmail.connect")) throw new DomainError("FORBIDDEN", "You may not complete a Gmail connection");
  const t: Q = await getDb();
  return withTx(async (tx: Database) => {
    const q: Q = tx;
    const rows = (await q.select().from(gmailConnections).where(eq(gmailConnections.id, input.connectionId)).limit(1).for("update")) as unknown as Array<typeof gmailConnections.$inferSelect>;
    const conn = rows[0];
    if (!conn) throw new DomainError("NOT_FOUND", "Connection not found");
    const e = (await import("@/lib/env")).env() as unknown as Record<string, string | undefined>;
    const clientId = conn.clientIdRef ? process.env[conn.clientIdRef] ?? "" : "fixture-client";
    const clientSecret = conn.clientSecretRef ? process.env[conn.clientSecretRef] ?? "" : "fixture-secret";
    if (clientId && !clientSecret && resolveGmailProviderName() === "google") {
      throw new DomainError("CONFIG", `OAuth client secret env var (${conn.clientSecretRef}) is not set`);
    }
    let tokens;
    try {
      tokens = await getGmailProvider().exchangeCode({
        clientId,
        clientSecret,
        redirectUri: conn.redirectUri ?? "http://localhost:3000/api/gmail/callback",
        code: input.code,
        codeVerifier: input.verifier,
      });
    } catch (err) {
      await q
        .update(gmailConnections)
        .set({ status: "ERROR", lastError: ((err as Error).message || "exchange failed").slice(0, 500), updatedAt: new Date() })
        .where(eq(gmailConnections.id, conn.id));
      throw err;
    }
    if (!tokens.refreshToken) {
      await q
        .update(gmailConnections)
        .set({
          status: "ERROR",
          lastError: "provider returned no offline refresh token — consent must include prompt=consent&access_type=offline",
          updatedAt: new Date(),
        })
        .where(eq(gmailConnections.id, conn.id));
      throw new DomainError("CONFIG", "Gmail did not return a refresh token; the mailbox was not connected");
    }
    await q
      .update(gmailConnections)
      .set({
        status: "CONNECTED",
        emailAddress: tokens.email ?? conn.emailAddress,
        scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
        refreshTokenCipher: sealPlaintext(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null,
        refreshTokenRotatedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(gmailConnections.id, conn.id));
    await auditIn(tx, {
      actor: input.actor,
      action: "UPDATE",
      entityType: "gmail_connection",
      entityId: conn.id,
      // Deliberately no token material of any kind in the audit trail
      metadata: { event: "connected", scopes: (tokens.scope ?? "").split(" ").filter(Boolean) },
    });
    return { emailAddress: tokens.email ?? conn.emailAddress };
  });
  void t;
}

export async function disconnect(actor: { id: string; email: string; role: string }, connectionId: string): Promise<void> {
  if (!can(actor.role as never, "gmail.manage")) throw new DomainError("FORBIDDEN", "You may not disconnect mailboxes");
  const t: Q = await getDb();
  await withTx(async (tx: Database) => {
    const q: Q = tx;
    const rows = (await q.select({ id: gmailConnections.id }).from(gmailConnections).where(eq(gmailConnections.id, connectionId)).limit(1)) as Array<{ id: string }>;
    if (!rows[0]) throw new DomainError("NOT_FOUND", "Connection not found");
    await q
      .update(gmailConnections)
      .set({ status: "DISCONNECTED", refreshTokenCipher: null, tokenExpiresAt: null, lastError: null, updatedAt: new Date() })
      .where(eq(gmailConnections.id, connectionId));
    await auditIn(tx, { actor, action: "UPDATE", entityType: "gmail_connection", entityId: connectionId, metadata: { event: "disconnected" } });
  });
}

/* ---------------- access token ---------------- */

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function accessTokenFor(conn: typeof gmailConnections.$inferSelect, tx?: Database): Promise<string> {
  const cached = tokenCache.get(conn.id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
  if (!conn.refreshTokenCipher) throw new DomainError("CONFIG", "Mailbox is not connected");
  const e = (await import("@/lib/env")).env() as unknown as Record<string, string | undefined>;
  const clientId = conn.clientIdRef ? process.env[conn.clientIdRef] ?? "fixture-client" : "fixture-client";
  const clientSecret = conn.clientSecretRef ? process.env[conn.clientSecretRef] ?? "fixture-secret" : "fixture-secret";
  const tokens = await getGmailProvider().refresh({
    clientId,
    clientSecret,
    refreshToken: openSealed(conn.refreshTokenCipher),
  });
  tokenCache.set(conn.id, {
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + Math.max(60, Number(tokens.expiresInSec ?? 3600)) * 1000,
  });
  if (tokens.refreshToken && tx) {
    // Google rotates refresh tokens on some consent flows: re-seal if so
    const q: Q = tx;
    await q
      .update(gmailConnections)
      .set({ refreshTokenCipher: sealPlaintext(tokens.refreshToken), refreshTokenRotatedAt: new Date(), updatedAt: new Date() })
      .where(eq(gmailConnections.id, conn.id));
  }
  void e;
  return tokens.accessToken;
}

/* ---------------- classification + matching ---------------- */

export interface InboundRule {
  classification: "APPLICATION_UPDATE" | "PAYMENT" | "NEW_REQUEST" | "SPAM" | "OTHER";
  keywords: string[];
}

async function readRules(t: Q): Promise<{ rules: InboundRule[]; pattern: RegExp | null; autoAttach: boolean }> {
  const rawRules = await getSettingIn<unknown>(t, "gmail.inboundRules", []);
  const rules: InboundRule[] = Array.isArray(rawRules)
    ? (rawRules as Array<Record<string, unknown>>)
        .filter((r) => Array.isArray(r?.keywords) && typeof r.classification === "string")
        .map((r) => ({
          classification: String(r.classification) as InboundRule["classification"],
          keywords: (r.keywords as unknown[]).map((k) => String(k).toLowerCase()).filter((k) => k.length >= 2).slice(0, 30),
        }))
    : [];
  const rawPattern = await getSettingIn<string>(t, "gmail.referencePattern", "ESF-\\d{4}-\\d{6}");
  let pattern: RegExp | null = null;
  if (typeof rawPattern === "string" && rawPattern.length <= 200) {
    try {
      pattern = new RegExp(rawPattern, "i");
    } catch {
      // a broken operator-supplied regex must not take intake down
      console.warn("[gmail] invalid gmail.referencePattern setting — reference matching disabled");
      pattern = null;
    }
  }
  const autoAttach = (await getSettingIn<boolean>(t, "gmail.autoAttachDocuments", true)) !== false;
  return { rules, pattern, autoAttach };
}

/** Rules first: deterministic, cheap, auditable, and configurable. */
export function classify(text: string, rules: InboundRule[]): { classification: string; confidence: number } {
  const haystack = text.toLowerCase();
  let best: { classification: string; hits: number } | null = null;
  for (const rule of rules) {
    const hits = rule.keywords.filter((k) => haystack.includes(k.toLowerCase())).length;
    if (hits && (!best || hits > best.hits)) best = { classification: rule.classification, hits };
  }
  if (!best) return { classification: "OTHER", confidence: 20 };
  return { classification: best.classification, confidence: Math.min(90, 35 + best.hits * 20) };
}

function extractEmail(value: string | null): string | null {
  if (!value) return null;
  const m = /([^\s,<>]+@[^\s,<>]+\.[a-z]{2,})/i.exec(value);
  return m ? m[1]!.toLowerCase() : null;
}

/** HTML from an inbound message is stored as plain text only; the raw markup is
 *  never persisted or rendered (prompt-injection and stored-XSS surface). */
export function stripHtml(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000);
}

export interface IngestResult {
  messageId: string;
  created: boolean;
  classification: string;
  matchedApplicationId: string | null;
  matchedAgencyId: string | null;
  matchedBy: string;
  confidence: number;
  requiresReview: boolean;
  attachmentsStaged: number;
}

/**
 * Store one inbound message. Idempotent on (connectionId, gmailMessageId):
 * a re-sync of the same mailbox returns the existing row untouched.
 */
export async function ingestMessage(connectionId: string, raw: RawGmailMessage): Promise<IngestResult> {
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const { rules, pattern, autoAttach } = await readRules(t);
    const body = (raw.bodyText || stripHtml(raw.bodyHtml)).slice(0, 20000);
    const subject = (raw.subject ?? "").slice(0, 500);
    const { classification, confidence } = classify(`${subject}\n${body}`, rules);

    const existing = (await t
      .select({ id: gmailMessages.id })
      .from(gmailMessages)
      .where(and(eq(gmailMessages.connectionId, connectionId), eq(gmailMessages.gmailMessageId, raw.id)))
      .limit(1)) as Array<{ id: string }>;
    if (existing[0]) {
      return {
        messageId: existing[0].id,
        created: false,
        classification,
        matchedApplicationId: null,
        matchedAgencyId: null,
        matchedBy: "ALREADY_IMPORTED",
        confidence: 100,
        requiresReview: false,
        attachmentsStaged: 0,
      };
    }

    // --- match an application by configured reference pattern ---
    let matchedApplicationId: string | null = null;
    let matchedAgencyId: string | null = null;
    let matchedBy = "NONE";
    let matchConfidence = 0;
    const refMatch = pattern ? pattern.exec(`${subject}\n${body}`) : null;
    if (refMatch) {
      const appRows = (await t
        .select({ id: visaApplications.id, agencyId: visaApplications.agencyId, caseOfficerUserId: visaApplications.caseOfficerUserId, reference: visaApplications.reference })
        .from(visaApplications)
        .where(eq(visaApplications.reference, refMatch[0]!.toUpperCase()))
        .limit(1)) as Array<{ id: string; agencyId: string; caseOfficerUserId: string | null; reference: string }>;
      const app = appRows[0];
      if (app) {
        matchedApplicationId = app.id;
        matchedAgencyId = app.agencyId;
        matchedBy = "REFERENCE";
        matchConfidence = 95;
      }
    }

    // --- otherwise recognise the sender through membership rows ---
    const fromEmail = extractEmail(raw.from);
    if (!matchedApplicationId && fromEmail) {
      const member = (await t
        .select({ agencyId: agencyMemberships.agencyId })
        .from(agencyMemberships)
        .innerJoin(users, eq(users.id, agencyMemberships.userId))
        .where(and(sql`lower(${users.email}) = lower(${fromEmail})`, eq(users.isActive, true)))
        .limit(2)) as Array<{ agencyId: string }>;
      if (member.length === 1) {
        matchedAgencyId = member[0].agencyId;
        matchedBy = "SENDER";
        matchConfidence = 70;
      } else if (member.length > 1) {
        // a sender belonging to several agencies must not be guessed at
        matchedBy = "AMBIGUOUS_SENDER";
        matchConfidence = 30;
      }
    }
    if (!matchedApplicationId && raw.inReplyTo) {
      const thread = (await t
        .select({ applicationId: communications.applicationId, agencyId: communications.agencyId })
        .from(communications)
        .where(and(eq(communications.messageId, raw.inReplyTo), sql`${communications.applicationId} is not null`))
        .limit(1)) as Array<{ applicationId: string | null; agencyId: string | null }>;
      const found = thread.find((x) => x.applicationId);
      if (found?.applicationId) {
        matchedApplicationId = found.applicationId;
        matchedAgencyId = found.agencyId ?? matchedAgencyId;
        matchedBy = "THREAD";
        matchConfidence = 80;
      }
    }

    const inserted = (await t
      .insert(gmailMessages)
      .values({
        connectionId,
        gmailMessageId: raw.id,
        gmailThreadId: raw.threadId,
        fromAddress: fromEmail,
        toAddresses: raw.to.slice(0, 20),
        subject,
        snippet: (raw.snippet ?? "").slice(0, 800),
        bodyText: body,
        bodyHtmlRedacted: Boolean(raw.bodyHtml),
        labels: (raw.labels ?? []).slice(0, 40),
        receivedAt: raw.receivedAt ? new Date(raw.receivedAt) : null,
        classification,
        classificationSource: "RULES",
        classificationConfidence: confidence,
        matchedAgencyId,
        matchedApplicationId,
        matchConfidence,
        matchedBy,
        requiresReview: matchedBy !== "REFERENCE" || classification === "PAYMENT",
      })
      .returning({ id: gmailMessages.id })) as Array<{ id: string }>;
    const messageId = inserted[0]!.id;

    // --- communications thread row (only when a tenant context is proven) ---
    if (matchedApplicationId || matchedAgencyId) {
      await t
        .insert(communications)
        .values({
          threadId: raw.threadId,
          direction: "INBOUND",
          agencyId: matchedAgencyId,
          applicationId: matchedApplicationId,
          channel: "GMAIL",
          fromAddress: fromEmail,
          toAddress: raw.to[0] ?? null,
          subject,
          body,
          bodyFormat: "text",
          messageId: raw.id,
          inReplyTo: raw.inReplyTo,
          sentAt: raw.receivedAt ? new Date(raw.receivedAt) : new Date(),
          matchedBy,
          matchConfidence,
          requiresReview: false,
        })
        .onConflictDoNothing();
    }

    // --- attachments are staged, never auto-attached to a file ---
    let staged = 0;
    if (autoAttach && raw.attachments.length) {
      // suggest a document type from configured document-type names/codes —
      // no hardcoded country or visa vocabulary in this code
      const types = (await t
        .select({ id: documentTypes.id, code: documentTypes.code, name: documentTypes.name })
        .from(documentTypes)
        .where(eq(documentTypes.isActive, true))) as Array<{ id: string; code: string; name: string }>;
      for (const att of raw.attachments.slice(0, 12)) {
        const guess = types.find((dt) => {
          const f = att.filename.toLowerCase();
          return f.includes(dt.code.toLowerCase()) || f.includes(dt.name.toLowerCase().replace(/\s+/g, "_")) || f.includes(dt.name.toLowerCase().replace(/\s+/g, "-"));
        });
        const res = await t
          .insert(gmailAttachments)
          .values({
            messageId,
            attachmentId: att.attachmentId,
            filename: att.filename.slice(0, 200),
            mimeType: att.mimeType.slice(0, 120),
            sizeBytes: Math.max(0, Number(att.sizeBytes ?? 0)),
            suggestedDocumentTypeCode: guess?.code ?? null,
            applicantGuess: null,
            confidence: guess ? 60 : 15,
          })
          .onConflictDoNothing()
          .returning({ id: gmailAttachments.id });
        if (res?.length) staged++;
      }
    }

    await auditIn(tx, {
      actor: null,
      action: "RECEIVE",
      entityType: "gmail_message",
      entityId: messageId,
      agencyId: matchedAgencyId,
      metadata: {
        connectionId,
        from: fromEmail,
        classification,
        confidence,
        matchedBy,
        matchedApplicationId,
        attachmentsStaged: staged,
      },
    });

    if (matchedApplicationId) {
      const apps = (await t
        .select({ reference: visaApplications.reference, agencyId: visaApplications.agencyId, caseOfficer: visaApplications.caseOfficerUserId })
        .from(visaApplications)
        .where(eq(visaApplications.id, matchedApplicationId))
        .limit(1)) as Array<{ reference: string; agencyId: string; caseOfficer: string | null }>;
      const app = apps[0]!;
      await notify(
        {
          staffOnly: true,
          ...(app.caseOfficer ? { userIds: [app.caseOfficer] } : { audienceRole: "VISA_AGENT" }),
          applicationId: app.reference ? matchedApplicationId : null,
          agencyId: app.agencyId,
          kind: "GMAIL_MATCHED",
          title: `Email received for ${app.reference}`,
          body: `${subject || "(no subject)"} — from ${fromEmail ?? "unknown"}. ${staged ? `${staged} attachment(s) staged for review.` : ""}`.slice(0, 1000),
          link: `/admin/inbox?message=${messageId}`,
          severity: "INFO",
          dedupeKey: `GMAIL_MATCHED:${messageId}`,
        },
        tx,
      );
    } else {
      await notify(
        {
          staffOnly: true,
          audienceRole: "ADMIN",
          kind: "GMAIL_UNMATCHED",
          title: `Unmatched inbound email`,
          body: `From ${fromEmail ?? "unknown"} — ${subject || "(no subject)"}. It was stored, not acted on: nothing in an email may change a file.`,
          link: `/admin/inbox`,
          severity: "ACTION_REQUIRED",
          dedupeKey: `GMAIL_UNMATCHED:${raw.id}`,
        },
        tx,
      );
    }

    return {
      messageId,
      created: true,
      classification,
      matchedApplicationId,
      matchedAgencyId,
      matchedBy,
      confidence,
      requiresReview: matchedBy !== "REFERENCE" || classification === "PAYMENT",
      attachmentsStaged: staged,
    };
  });
}

export interface SyncResult {
  connectionId: string;
  fetched: number;
  imported: number;
  skipped: number;
  unmatched: number;
  error: string | null;
}

/** Pull the mailbox and ingest. Safe to run on a schedule (idempotent). */
export async function syncInbox(actor: { id: string; email: string; role: string }, connectionId: string, opts: { max?: number; query?: string } = {}): Promise<SyncResult> {
  if (!can(actor.role as never, "gmail.manage")) throw new DomainError("FORBIDDEN", "You may not sync mailboxes");
  const t: Q = await getDb();
  const rows = (await t.select().from(gmailConnections).where(eq(gmailConnections.id, connectionId)).limit(1)) as Array<typeof gmailConnections.$inferSelect>;
  const conn = rows[0];
  if (!conn) throw new DomainError("NOT_FOUND", "Connection not found");
  if (conn.status !== "CONNECTED") throw new DomainError("STATE_CONFLICT", "This mailbox is not connected");
  const enabled = (await getSettingIn<boolean>(t, "gmail.enabled", false)) === true;
  if (!enabled) throw new DomainError("STATE_CONFLICT", "Gmail intake is switched off in Settings → Gmail");
  const provider = getGmailProvider();
  const accessToken = await accessTokenFor(conn);
  const query = opts.query ?? (process.env.GMAIL_POLL_QUERY ?? "in:inbox newer_than:30d");
  let result: SyncResult = { connectionId, fetched: 0, imported: 0, skipped: 0, unmatched: 0, error: null };
  try {
    const listed = await provider.list({ accessToken, query, maxResults: Math.min(50, Math.max(1, opts.max ?? 15)) });
    result.fetched = listed.messages.length;
    for (const msg of listed.messages) {
      const ing = await ingestMessage(connectionId, msg);
      if (ing.created) {
        result.imported++;
        if (!ing.matchedApplicationId && !ing.matchedAgencyId) result.unmatched++;
      } else result.skipped++;
    }
    await t
      .update(gmailConnections)
      .set({ lastSyncAt: new Date(), lastHistoryId: listed.historyId, lastError: null, updatedAt: new Date() })
      .where(eq(gmailConnections.id, connectionId));
  } catch (err) {
    const message = ((err as Error).message || "sync failed").slice(0, 500);
    result.error = message;
    await t
      .update(gmailConnections)
      .set({ lastError: message, status: "ERROR", updatedAt: new Date() })
      .where(eq(gmailConnections.id, connectionId));
    await auditIn(t as unknown as Database, {
      actor,
      action: "UPDATE",
      entityType: "gmail_connection",
      entityId: connectionId,
      metadata: { event: "sync_failed", error: message },
    });
  }
  return result;
}

/* ---------------- staff review ---------------- */

export interface ReviewRow {
  id: string;
  subject: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  classification: string | null;
  confidence: number | null;
  matchedBy: string | null;
  reference: string | null;
  agencyName: string | null;
  bodyPreview: string;
  attachments: Array<{ id: string; filename: string; mimeType: string | null; sizeBytes: number; suggested: string | null; linked: boolean; documentId: string | null }>;
}

export async function listInboundQueue(
  actor: OpActor,
  opts: { onlyUnreviewed?: boolean; limit?: number } = {},
): Promise<ReviewRow[]> {
  assertActorPermission(actor, "communications.read");
  const t: Q = await getDb();
  const conds: unknown[] = [];
  if (opts.onlyUnreviewed) conds.push(eq(gmailMessages.requiresReview, true));
  if (!actor.isStaff) {
    // A partner sees only mail proven to belong to them by sender/reference
    // matching. Unmatched mail is invisible, so the queue cannot be walked for
    // other tenants' traffic.
    if (!actor.agencyIds.length) conds.push(sql`false`);
    else conds.push(inArray(gmailMessages.matchedAgencyId, actor.agencyIds));
  }
  const rows = (await t
    .select({
      id: gmailMessages.id,
      subject: gmailMessages.subject,
      fromAddress: gmailMessages.fromAddress,
      receivedAt: gmailMessages.receivedAt,
      classification: gmailMessages.classification,
      confidence: gmailMessages.classificationConfidence,
      matchedBy: gmailMessages.matchedBy,
      bodyText: gmailMessages.bodyText,
      reference: visaApplications.reference,
      agencyName: agencies.name,
    })
    .from(gmailMessages)
    .leftJoin(visaApplications, eq(visaApplications.id, gmailMessages.matchedApplicationId))
    .leftJoin(agencies, eq(agencies.id, gmailMessages.matchedAgencyId))
    .where(conds.length ? and(...(conds as never[])) : undefined)
    .orderBy(desc(gmailMessages.receivedAt))
    .limit(Math.min(200, Math.max(1, opts.limit ?? 40)))) as unknown as Array<Record<string, any>>;
  const ids = rows.map((r) => r.id as string);
  const atts = ids.length
    ? ((await t
        .select({
          id: gmailAttachments.id,
          messageId: gmailAttachments.messageId,
          filename: gmailAttachments.filename,
          mimeType: gmailAttachments.mimeType,
          sizeBytes: gmailAttachments.sizeBytes,
          suggested: gmailAttachments.suggestedDocumentTypeCode,
          documentId: gmailAttachments.documentId,
        })
        .from(gmailAttachments)
        .where(inArray(gmailAttachments.messageId, ids))) as Array<Record<string, any>>)
    : [];
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject ?? null,
    fromAddress: r.fromAddress ?? null,
    receivedAt: r.receivedAt ? String(r.receivedAt) : null,
    classification: r.classification ?? null,
    confidence: r.confidence ?? null,
    matchedBy: r.matchedBy ?? null,
    reference: r.reference ?? null,
    agencyName: r.agencyName ?? null,
    bodyPreview: String(r.bodyText ?? "").slice(0, 400),
    attachments: atts
      .filter((a) => a.messageId === r.id)
      .map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType ?? null,
        sizeBytes: Number(a.sizeBytes ?? 0),
        suggested: a.suggested ?? null,
        linked: Boolean(a.documentId),
        documentId: a.documentId ?? null,
      })),
  }));
}

/**
 * A staff member links a staged attachment to a file. The upload pipeline does
 * the real work — tenant proof, sniffing, checklist rules, audit — and
 * `externalId` makes a repeated link a no-op instead of a second document.
 */
export async function linkAttachmentToApplication(
  actor: OpActor,
  input: { attachmentId: string; applicationId: string; documentTypeCode: string; applicantId?: string | null },
): Promise<{ documentId: string; alreadyLinked: boolean }> {
  assertActorPermission(actor, "applications.review");
  if (!actor.isStaff) throw new DomainError("FORBIDDEN", "Only ESSAFARIA staff may confirm an import");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const rows = (await t
      .select()
      .from(gmailAttachments)
      .where(eq(gmailAttachments.id, input.attachmentId))
      .limit(1)
      .for("update")) as unknown as Array<typeof gmailAttachments.$inferSelect>;
    const att = rows[0];
    if (!att) throw new DomainError("NOT_FOUND", "Attachment not found");
    if (att.documentId) return { documentId: att.documentId, alreadyLinked: true };

    // fetch the bytes from the provider (never trusted for content rules)
    const msg = (await t.select().from(gmailMessages).where(eq(gmailMessages.id, att.messageId)).limit(1)) as Array<typeof gmailMessages.$inferSelect>;
    const message = msg[0];
    if (!message) throw new DomainError("NOT_FOUND", "Source message missing");
    const conn = (await t.select().from(gmailConnections).where(eq(gmailConnections.id, message.connectionId ?? "")).limit(1)) as Array<typeof gmailConnections.$inferSelect>;
    const connection = conn[0];
    let bytes: Buffer;
    if (connection) {
      const accessToken = await accessTokenFor(connection, tx);
      const fetched = await getGmailProvider().getAttachment({ accessToken, messageId: message.gmailMessageId, attachmentId: att.attachmentId });
      if (!fetched) throw new DomainError("NOT_FOUND", "Attachment bytes could not be retrieved");
      bytes = fetched.bytes;
    } else {
      throw new DomainError("CONFIG", "Mailbox connection missing");
    }

    const { uploadDocumentInsideTx } = await import("@/lib/documents");
    const uploaded = await uploadDocumentInsideTx(tx, actor, input.applicationId, {
      bytes,
      filename: att.filename,
      claimedMime: att.mimeType,
      documentTypeCode: input.documentTypeCode,
      applicantId: input.applicantId ?? null,
      agencyNotes: "Imported from an inbound email",
      source: "GMAIL",
      // idempotency: the same Gmail attachment can never create a second document
      externalId: `gmail:${message.id}:${att.attachmentId}`,
    });

    await t
      .update(gmailAttachments)
      .set({ documentId: uploaded.documentId, mediaId: uploaded.mediaId, linkedBy: actor.id, linkedAt: new Date() })
      .where(and(eq(gmailAttachments.id, att.id), isNull(gmailAttachments.documentId)));
    await t
      .update(gmailMessages)
      .set({ requiresReview: false, reviewedBy: actor.id, reviewedAt: new Date() })
      .where(eq(gmailMessages.id, message.id));
    await auditIn(tx, {
      actor,
      action: "ASSIGN",
      entityType: "gmail_attachment",
      entityId: att.id,
      metadata: { applicationId: input.applicationId, documentId: uploaded.documentId, documentTypeCode: input.documentTypeCode },
    });
    return { documentId: uploaded.documentId, alreadyLinked: false };
  });
}

export async function dismissInbound(actor: OpActor, messageId: string, note: string | null): Promise<void> {
  assertActorPermission(actor, "applications.review");
  if (!actor.isStaff) throw new DomainError("FORBIDDEN", "Only staff may clear the intake queue");
  const t: Q = await getDb();
  await withTx(async (tx: Database) => {
    const q: Q = tx;
    const res = await q
      .update(gmailMessages)
      .set({ requiresReview: false, reviewedBy: actor.id, reviewedAt: new Date(), importError: note?.slice(0, 500) ?? null })
      .where(eq(gmailMessages.id, messageId));
    if (affectedRows(res) !== 1) throw new DomainError("NOT_FOUND", "Message not found");
    await auditIn(tx, { actor, action: "UPDATE", entityType: "gmail_message", entityId: messageId, metadata: { dismissed: true, note: note ?? null } });
  });
}

/**
 * Compose a reply as a DRAFT in the connected mailbox. Nothing is sent: the
 * platform has no send scope. The draft reference is stored so the desk can see
 * what is waiting for a human.
 */
export async function draftReply(
  actor: OpActor,
  input: { messageId: string; body: string },
): Promise<{ draftId: string }> {
  assertActorPermission(actor, "communications.write");
  if (!actor.isStaff) throw new DomainError("FORBIDDEN", "Only ESSAFARIA staff may draft replies to inbound mail");
  const body = input.body.trim();
  if (body.length < 10) throw new DomainError("VALIDATION", "Write a real reply before creating the draft");
  const t: Q = await getDb();
  const rows = (await t.select().from(gmailMessages).where(eq(gmailMessages.id, input.messageId)).limit(1)) as Array<typeof gmailMessages.$inferSelect>;
  const message = rows[0];
  if (!message) throw new DomainError("NOT_FOUND", "Message not found");
  if (!message.fromAddress) throw new DomainError("STATE_CONFLICT", "This message has no reply address");
  const conn = (await t
    .select()
    .from(gmailConnections)
    .where(eq(gmailConnections.id, message.connectionId ?? ""))
    .limit(1)) as Array<typeof gmailConnections.$inferSelect>;
  const connection = conn[0];
  if (!connection || connection.status !== "CONNECTED") throw new DomainError("STATE_CONFLICT", "The mailbox is not connected");
  const accessToken = await accessTokenFor(connection);
  const subject = message.subject && message.subject.toLowerCase().startsWith("re:") ? message.subject : `Re: ${message.subject ?? "(no subject)"}`;
  const draft = await getGmailProvider().createDraft({
    accessToken,
    threadId: message.gmailThreadId,
    to: message.fromAddress,
    subject,
    body,
    inReplyTo: message.gmailMessageId,
  });
  await withTx(async (tx: Database) => {
    const q: Q = tx;
    await q
      .insert(communications)
      .values({
        threadId: message.gmailThreadId,
        direction: "OUTBOUND",
        agencyId: message.matchedAgencyId,
        applicationId: message.matchedApplicationId,
        userId: actor.id,
        channel: "GMAIL",
        fromAddress: connection.emailAddress,
        toAddress: message.fromAddress,
        subject,
        body: body.slice(0, 20000),
        bodyFormat: "text",
        messageId: draft.draftId ? `draft:${draft.draftId}` : null,
        inReplyTo: message.gmailMessageId,
        sendState: "SKIPPED",
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    await auditIn(tx, {
      actor,
      action: "CREATE",
      entityType: "gmail_draft",
      entityId: message.id,
      agencyId: message.matchedAgencyId,
      metadata: { draftId: draft.draftId, to: message.fromAddress, note: "draft only — the platform never sends" },
    });
  });
  return { draftId: draft.draftId };
}

/** Health check used by the admin page and /api/health consumers. */
export function gmailStatus(): { provider: string; tokenKeyConfigured: boolean; available: boolean } {
  return {
    provider: resolveGmailProviderName(),
    tokenKeyConfigured: tokenKeyConfigured(),
    available: gmailProviderAvailable(),
  };
}
