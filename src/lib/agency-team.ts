import { and, asc, count, eq, sql } from "drizzle-orm";
import { agencyMemberships, agencies, getDb, users, visaApplications, type Database } from "@/db";
import { auditIn, DomainError } from "@/lib/ops";
import { withTx } from "@/lib/with-tx";
import { can } from "@/lib/rbac";
import { notify } from "@/lib/notifications";
import { hashPassword, randomToken } from "@/lib/password";
import type { OpActor } from "@/lib/guard";

type Q = any;

/* ============================================================
 * Agency team management (Phase 6).
 *
 * A partner admin may grow and shrink their own tenant's access list — and
 * nothing else. Rules enforced here, in the service:
 *   • every id is resolved against the actor's own agency; a foreign agencyId
 *     answers NOT_FOUND, never "forbidden"
 *   • a user already attached to ANOTHER agency cannot be pulled into this one
 *     by a partner admin (that would merge two tenants); only platform staff
 *     may create such a cross-agency membership deliberately
 *   • the last AGENCY_ADMIN of a tenant cannot be demoted or removed, so an
 *     agency can never lock itself out of its own portal
 *   • a partner admin cannot reset another person's password — that would be
 *     standing credential access. Only ESSAFARIA SUPER_ADMIN may (admin/users).
 * ============================================================ */

export type AgencyRole = "AGENCY_ADMIN" | "AGENCY_USER";
const AGENCY_ROLES_ALLOWED: AgencyRole[] = ["AGENCY_ADMIN", "AGENCY_USER"];

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  isPrimary: boolean;
  lastLoginAt: string | null;
  applicationsCreated: number;
}

/** Resolve the agency an operation may touch, or throw the NOT_FOUND shape. */
async function scopedAgencyId(t: Q, actor: OpActor, requested?: string | null): Promise<string> {
  if (actor.isStaff) {
    if (!requested) throw new DomainError("VALIDATION", "An agency must be specified");
    const rows = (await t.select({ id: agencies.id }).from(agencies).where(eq(agencies.id, requested)).limit(1)) as Array<{ id: string }>;
    if (!rows[0]) throw new DomainError("NOT_FOUND", "Agency not found");
    return rows[0].id;
  }
  const target = requested && actor.agencyIds.includes(requested) ? requested : actor.agencyIds[0];
  if (!target) throw new DomainError("NOT_FOUND", "Agency not found");
  return target;
}

export async function listTeam(actor: OpActor, requestedAgencyId?: string | null): Promise<{ agencyId: string; agencyName: string; members: MemberView[] }> {
  const t: Q = await getDb();
  const agencyId = await scopedAgencyId(t, actor, requestedAgencyId ?? null);
  const [agency] = (await t.select().from(agencies).where(eq(agencies.id, agencyId)).limit(1)) as Array<{ id: string; name: string }>;
  const rows = (await t
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      isPrimary: agencyMemberships.isPrimary,
      lastLoginAt: users.lastLoginAt,
    })
    .from(agencyMemberships)
    .innerJoin(users, eq(users.id, agencyMemberships.userId))
    .where(eq(agencyMemberships.agencyId, agencyId))
    .orderBy(asc(users.name))) as unknown as Array<Omit<MemberView, "applicationsCreated">>;
  // one grouped query for "how many files did each member open" (no N+1)
  const perUser = new Map<string, number>();
  if (rows.length) {
    const stats = (await t
      .select({ createdBy: visaApplications.createdByUserId, n: count() })
      .from(visaApplications)
      .where(eq(visaApplications.agencyId, agencyId))
      .groupBy(visaApplications.createdByUserId)) as Array<{ createdBy: string | null; n: number }>;
    for (const st of stats) if (st.createdBy) perUser.set(st.createdBy, Number(st.n));
  }
  return {
    agencyId,
    agencyName: agency.name,
    members: rows.map((r) => ({ ...r, applicationsCreated: perUser.get(r.userId) ?? 0, lastLoginAt: r.lastLoginAt ? String(r.lastLoginAt) : null })),
  };
}

export interface AddMemberInput {
  email: string;
  name?: string | null;
  role: AgencyRole;
  /** optional; when absent a strong temporary password is generated and shown once */
  password?: string | null;
  isPrimary?: boolean;
}

export async function addTeamMember(actor: OpActor, input: AddMemberInput, requestedAgencyId?: string | null): Promise<{ userId: string; created: boolean; tempPassword?: string }> {
  if (!can(actor.role, "agencies.users.manage")) throw new DomainError("FORBIDDEN", "You may not manage this agency's users");
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || email.length > 254) throw new DomainError("VALIDATION", "Enter a valid email address");
  if (!AGENCY_ROLES_ALLOWED.includes(input.role)) throw new DomainError("VALIDATION", "Portal users may only be AGENCY_ADMIN or AGENCY_USER");
  if (input.password && input.password.length < 10) throw new DomainError("VALIDATION", "Password must be at least 10 characters");

  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const agencyId = await scopedAgencyId(t, actor, requestedAgencyId ?? null);
    const existing = (await t.select().from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1)) as Array<typeof users.$inferSelect>;
    const user = existing[0];

    if (user) {
      if (!actor.isStaff) {
        // never fold another tenant into this one behind their back
        const other = (await t
          .select({ agencyId: agencyMemberships.agencyId })
          .from(agencyMemberships)
          .where(eq(agencyMemberships.userId, user.id))) as Array<{ agencyId: string }>;
        if (other.length && !other.some((o) => o.agencyId === agencyId)) {
          throw new DomainError(
            "STATE_CONFLICT",
            "That account already belongs to a different agency. Ask ESSAFARIA to link accounts deliberately.",
          );
        }
        if (!AGENCY_ROLES_ALLOWED.includes(user.role as AgencyRole)) {
          throw new DomainError("STATE_CONFLICT", "That email belongs to an ESSAFARIA staff account");
        }
      }
      const linked = (await t
        .select({ userId: agencyMemberships.userId })
        .from(agencyMemberships)
        .where(and(eq(agencyMemberships.agencyId, agencyId), eq(agencyMemberships.userId, user.id)))
        .limit(1)) as Array<{ userId: string }>;
      if (linked.length) {
        await t.update(agencyMemberships).set({ isPrimary: Boolean(input.isPrimary) }).where(and(eq(agencyMemberships.agencyId, agencyId), eq(agencyMemberships.userId, user.id)));
        return { userId: user.id, created: false };
      }
      if (input.isPrimary) await t.update(agencyMemberships).set({ isPrimary: false }).where(eq(agencyMemberships.agencyId, agencyId));
      await t.insert(agencyMemberships).values({ agencyId, userId: user.id, isPrimary: Boolean(input.isPrimary) });
      if (!user.isActive) await t.update(users).set({ isActive: true, updatedAt: new Date() }).where(eq(users.id, user.id));
      await auditIn(tx, { actor, action: "ASSIGN", entityType: "agency_membership", entityId: user.id, agencyId, metadata: { email, reusedAccount: true } });
      await notify(
        {
          userIds: [user.id],
          agencyId,
          kind: "TEAM_JOINED",
          title: "You have access to a new agency portal",
          body: `${actor.email} linked your account to this agency in the ESSAFARIA partner portal.`,
          link: "/agency",
          severity: "INFO",
          dedupeKey: `TEAM_JOINED:${agencyId}:${user.id}`,
        },
        tx,
      );
      return { userId: user.id, created: false };
    }

    const temp = input.password ?? `esf-${randomToken(6)}`;
    const passwordHash = await hashPassword(temp);
    const inserted = (await t
      .insert(users)
      .values({
        email,
        name: (input.name ?? "").trim() || email.split("@")[0]!,
        passwordHash,
        role: input.role,
        isActive: true,
      })
      .returning({ id: users.id })) as Array<{ id: string }>;
    const userId = inserted[0]!.id;
    const admins = (await t
      .select({ n: count() })
      .from(agencyMemberships)
      .innerJoin(users, eq(users.id, agencyMemberships.userId))
      .where(and(eq(agencyMemberships.agencyId, agencyId), eq(users.role, "AGENCY_ADMIN")))) as Array<{ n: number }>;
    const isPrimary = Boolean(input.isPrimary) || Number(admins[0]?.n ?? 0) === 0;
    if (isPrimary) await t.update(agencyMemberships).set({ isPrimary: false }).where(eq(agencyMemberships.agencyId, agencyId));
    await t.insert(agencyMemberships).values({ agencyId, userId, isPrimary });
    await auditIn(tx, {
      actor,
      action: "CREATE",
      entityType: "user",
      entityId: userId,
      agencyId,
      // the password value is never written to the audit trail
      metadata: { email, role: input.role, generatedPassword: !input.password },
    });
    await notify(
      {
        userIds: [userId],
        agencyId,
        kind: "WELCOME",
        title: "Your ESSAFARIA portal account is ready",
        body: input.password
          ? "An account was created for you. Sign in at /login to upload documents and track applications."
          : `An account was created for you with a temporary password: ${temp}. Sign in at /login and change it promptly.`,
        link: "/agency",
        severity: "ACTION_REQUIRED",
        dedupeKey: `WELCOME:${userId}`,
      },
      tx,
    );
    return { userId, created: true, tempPassword: input.password ? undefined : temp };
  });
}

export async function setMemberRole(actor: OpActor, userId: string, role: AgencyRole): Promise<void> {
  if (!can(actor.role, "agencies.users.manage")) throw new DomainError("FORBIDDEN", "You may not manage this agency's users");
  if (!AGENCY_ROLES_ALLOWED.includes(role)) throw new DomainError("VALIDATION", "Portal users may only be AGENCY_ADMIN or AGENCY_USER");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const agencyId = await memberAgency(t, actor, userId);
    if (role === "AGENCY_USER") await assertNotLastAdmin(t, agencyId, userId);
    await t.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
    await auditIn(tx, {
      actor,
      action: "UPDATE",
      entityType: "user",
      entityId: userId,
      agencyId,
      changes: { after: { role } },
    });
  });
}

export async function removeTeamMember(actor: OpActor, userId: string): Promise<void> {
  if (!can(actor.role, "agencies.users.manage")) throw new DomainError("FORBIDDEN", "You may not manage this agency's users");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const agencyId = await memberAgency(t, actor, userId);
    if (userId === actor.id) throw new DomainError("VALIDATION", "You cannot remove your own access");
    await assertNotLastAdmin(t, agencyId, userId);
    await t.delete(agencyMemberships).where(and(eq(agencyMemberships.agencyId, agencyId), eq(agencyMemberships.userId, userId)));
    await auditIn(tx, {
      actor,
      action: "REMOVE",
      entityType: "agency_membership",
      entityId: userId,
      agencyId,
      metadata: { reason: "removed by agency admin" },
    });
  });
}

async function memberAgency(t: Q, actor: OpActor, userId: string): Promise<string> {
  const agencyId = actor.isStaff ? null : actor.agencyIds[0];
  const rows = (await t
    .select({ agencyId: agencyMemberships.agencyId })
    .from(agencyMemberships)
    .where(agencyId ? and(eq(agencyMemberships.userId, userId), eq(agencyMemberships.agencyId, agencyId)) : eq(agencyMemberships.userId, userId))
    .limit(1)) as Array<{ agencyId: string }>;
  const found = rows[0]?.agencyId;
  if (!found) throw new DomainError("NOT_FOUND", "Member not found in this agency");
  return found;
}

async function assertNotLastAdmin(t: Q, agencyId: string, userId: string): Promise<void> {
  const admins = (await t
    .select({ id: users.id })
    .from(agencyMemberships)
    .innerJoin(users, eq(users.id, agencyMemberships.userId))
    .where(and(eq(agencyMemberships.agencyId, agencyId), eq(users.role, "AGENCY_ADMIN"), eq(users.isActive, true)))) as Array<{ id: string }>;
  if (admins.length <= 1 && admins[0]?.id === userId) {
    throw new DomainError("STATE_CONFLICT", "This is the agency's only administrator — promote someone else first");
  }
}

/** Primary contact flag — one per agency. */
export async function setPrimaryContact(actor: OpActor, userId: string): Promise<void> {
  if (!can(actor.role, "agencies.users.manage")) throw new DomainError("FORBIDDEN", "You may not manage this agency's users");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const agencyId = await memberAgency(t, actor, userId);
    await t.update(agencyMemberships).set({ isPrimary: false }).where(eq(agencyMemberships.agencyId, agencyId));
    await t.update(agencyMemberships).set({ isPrimary: true }).where(and(eq(agencyMemberships.agencyId, agencyId), eq(agencyMemberships.userId, userId)));
    await auditIn(tx, { actor, action: "ASSIGN", entityType: "agency_membership", entityId: userId, agencyId, metadata: { primary: true } });
  });
}
