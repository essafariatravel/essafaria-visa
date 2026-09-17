import { eq, and, inArray } from "drizzle-orm";
import { getDb, agencies, agencyMemberships } from "@/db";
import { AGENCY_ROLES, type Role } from "@/lib/rbac";
import type { SessionUser } from "@/lib/session";

/* ============================================================
 * Multi-tenancy — enforced server-side, on every query path.
 * A URL like /agency/XYZ never grants access: the agency scope
 * comes from the session's memberships only.
 * ============================================================ */

export class TenantError extends Error {
  constructor(message = "Agency access denied") {
    super(message);
    this.name = "TenantError";
  }
}

export function isAgencyRole(role: Role): boolean {
  return AGENCY_ROLES.includes(role);
}

/** Agency ids the given user may access. Staff may impersonate none by default. */
export async function accessibleAgencyIds(user: SessionUser): Promise<string[]> {
  if (isAgencyRole(user.role)) {
    const db = await getDb();
    const rows = await db
      .select({ agencyId: agencyMemberships.agencyId })
      .from(agencyMemberships)
      .where(eq(agencyMemberships.userId, user.id));
    return [...new Set(rows.map((r) => r.agencyId))];
  }
  // Platform staff see all agencies for administration; agency-scoped
  // operational screens still require an explicit, active agency.
  const db = await getDb();
  const rows = await db.select({ id: agencies.id }).from(agencies);
  return rows.map((r) => r.id);
}

/** Throws unless `agencyId` is within the user's tenant scope. */
export async function assertAgencyAccess(user: SessionUser, agencyId: string): Promise<void> {
  if (isAgencyRole(user.role)) {
    const db = await getDb();
    const rows = await db
      .select({ agencyId: agencyMemberships.agencyId })
      .from(agencyMemberships)
      .where(
        and(
          eq(agencyMemberships.userId, user.id),
          eq(agencyMemberships.agencyId, agencyId),
        ),
      )
      .limit(1);
    if (rows.length === 0) throw new TenantError();
  }
}

/** For agency portal pages: resolve THE single agency for this session. */
export async function resolveAgencyContext(user: SessionUser): Promise<string | null> {
  if (!isAgencyRole(user.role)) return null;
  const db = await getDb();
  const rows = await db
    .select({ agencyId: agencyMemberships.agencyId, isPrimary: agencyMemberships.isPrimary })
    .from(agencyMemberships)
    .where(eq(agencyMemberships.userId, user.id))
    .orderBy(agencyMemberships.isPrimary);
  return rows[0]?.agencyId ?? null;
}

/** Filter helper: constrain any agency-scoped query to allowed ids. */
export function tenantIn(agencyIds: string[]) {
  return inArray(agencies.id, agencyIds);
}
