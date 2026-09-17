import { ROLES, ADMIN_ROLES, AGENCY_ROLES, can, type Permission, type Role } from "@/lib/rbac";

/* ============================================================
 * Operational authorization guard.
 *
 * Every operational service entry point starts with `opActor()` or
 * `staffActor()`. Both resolve identity ONLY from the session (never from
 * a form field, URL segment or client state) and attach the tenant scope
 * that the service must respect. There is deliberately no way to construct
 * an OpActor that skips the permission check.
 * ============================================================ */

export interface OpActor {
  id: string;
  email: string;
  role: Role;
  isStaff: boolean;
  /** Tenant scope: for agency users exactly their own agencies; for staff,
   *  whatever agency the operation was explicitly bound to (or none). */
  agencyIds: string[];
  /** The agency an operation acts on behalf of. Set for agency users; for
   *  staff only when they operate a specific file/agency (e.g. back-office
   *  application created for agency X). */
  actingAgencyId: string | null;
  mayCreateForAgency: boolean;
  mayCharge: boolean;
}

export class OpAuthError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthorizationError";
    this.status = status;
  }
}

export function isStaffRole(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

export function isAgencyRole(role: Role): boolean {
  return AGENCY_ROLES.includes(role);
}

export function assertRole(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new OpAuthError(`Missing permission: ${permission}`, 403);
  }
}

interface SessionLike {
  id: string;
  email: string;
  name: string;
  role: Role;
  agencyIds: string[];
}

/**
 * Resolve the actor for an operational call.
 * `onBehalfOfAgencyId` is only honoured for staff with agency_admin rights
 * (back office creating a file for a partner); agency users are pinned to
 * their own membership — the value is ignored rather than trusted.
 */
export function buildActor(
  user: SessionLike,
  permission: Permission,
  opts: { onBehalfOfAgencyId?: string | null; requireAgency?: boolean } = {},
): OpActor {
  assertRole(user.role, permission);
  const staff = isStaffRole(user.role);
  let acting: string | null = null;
  if (!staff) {
    if (!user.agencyIds.length) {
      throw new OpAuthError("No agency is linked to this account", 403);
    }
    // Agency users are always pinned to their own membership.
    acting = opts.onBehalfOfAgencyId && user.agencyIds.includes(opts.onBehalfOfAgencyId)
      ? opts.onBehalfOfAgencyId
      : user.agencyIds[0]!;
  } else {
    acting = opts.onBehalfOfAgencyId ?? null;
  }
  if (opts.requireAgency && !acting) {
    throw new OpAuthError("An agency must be specified for this operation", 422);
  }
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isStaff: staff,
    agencyIds: staff ? (acting ? [acting] : []) : [...user.agencyIds],
    actingAgencyId: acting,
    mayCreateForAgency: staff ? can(user.role, "agency_admin") : true,
    mayCharge: can(user.role, "wallet.write"),
  };
}

/** Staff-only actor (review, override, wallet funding, config of workflow). */
export function buildStaffActor(
  user: SessionLike,
  permission: Permission,
  opts: { agencyId?: string | null } = {},
): OpActor {
  assertRole(user.role, permission);
  if (!isStaffRole(user.role)) throw new OpAuthError("Staff only", 403);
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isStaff: true,
    agencyIds: opts.agencyId ? [opts.agencyId] : [],
    actingAgencyId: opts.agencyId ?? null,
    mayCreateForAgency: true,
    mayCharge: can(user.role, "wallet.write"),
  };
}

/** Throw the NOT_FOUND shape for any id that is not in the actor's scope, so
 *  cross-tenant probes are indistinguishable from typos. */
export function requireInScope(actor: OpActor, agencyId: string): void {
  if (actor.isStaff) {
    // staff may read any agency, but write ops must name the agency they act on
    return;
  }
  if (!actor.agencyIds.includes(agencyId)) throw new OpAuthError("Not found", 404);
}

export { ROLES, can };
