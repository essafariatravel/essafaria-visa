/* ============================================================
 * Role-Based Access Control — capability catalog + role grants.
 *
 * Authorization is evaluated SERVER-SIDE only (route handlers,
 * server actions, services). Hiding a button in the UI is UX,
 * never security. The matrix is code-defined but expressed as
 * discrete capabilities so it can move to per-user grants in the
 * database later without touching call sites.
 * ============================================================ */

export const ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "VISA_AGENT",
  "ACCOUNTING",
  "AGENCY_ADMIN",
  "AGENCY_USER",
] as const;

export type Role = (typeof ROLES)[number];

export const ADMIN_ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "VISA_AGENT", "ACCOUNTING"];
export const AGENCY_ROLES: Role[] = ["AGENCY_ADMIN", "AGENCY_USER"];

export const PERMISSIONS = [
  // administration of platform users & tenants
  "agencies.read",
  "agencies.write",
  "agencies.users.manage",
  "users.read",
  "users.write",
  // visa business configuration
  "countries.read",
  "countries.write",
  "visa_categories.read",
  "visa_categories.write",
  "visa_types.read",
  "visa_types.write",
  "visa_requirements.read",
  "visa_requirements.write",
  "document_types.read",
  "document_types.write",
  "statuses.read",
  "statuses.write",
  "priorities.read",
  "priorities.write",
  "currencies.read",
  "currencies.write",
  "pricing.read",
  "pricing.write",
  // communication
  "templates.read",
  "templates.write",
  // CMS / presentation
  "branding.read",
  "branding.write",
  "content.read",
  "content.write",
  "navigation.read",
  "navigation.write",
  "settings.read",
  "settings.write",
  "media.read",
  "media.write",
  // oversight & portals
  "audit_logs.read",
  "dashboard.view",
  "agency_portal.access",
  // operations (Phase 3+) — applications, documents, money, communication
  "applications.read",
  "applications.write",
  "applications.submit",
  "applications.review",
  "applications.override",
  "applications.assign",
  "applications.manage_all",
  "documents.upload",
  "wallet.read",
  "wallet.write",
  "wallet.charge",
  "invoices.read",
  "invoices.write",
  "notifications.read",
  "notifications.send",
  "communications.read",
  "communications.write",
  "gmail.connect",
  "gmail.manage",
  "ai.use",
  "ai.review",
  "agency_admin",
  "reports.read",
  "reports.export",
  "automation.run",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

const READ_ONLY_CATALOG: Permission[] = [
  "countries.read",
  "visa_categories.read",
  "visa_types.read",
  "visa_requirements.read",
  "document_types.read",
  "statuses.read",
  "priorities.read",
  "currencies.read",
  "templates.read",
  "branding.read",
  "content.read",
  "navigation.read",
  "media.read",
  "dashboard.view",
];

const VISA_AGENT: Permission[] = [
  ...READ_ONLY_CATALOG,
  "visa_types.write",
  "visa_requirements.write",
  "agencies.read",
  "pricing.read",
  // the operational desk: works files end-to-end, but does not move money
  "applications.read",
  "applications.write",
  "applications.submit",
  "applications.review",
  "applications.override",
  "applications.assign",
  "documents.upload",
  "wallet.read",
  "invoices.read",
  "notifications.read",
  "notifications.send",
  "communications.read",
  "communications.write",
  "ai.use",
  "ai.review",
  "reports.read",
  // the desk may run its own reminders and sweeps; note what this role still
  // cannot do: move money, override pricing, or change configuration
  "automation.run",
];

const ACCOUNTING: Permission[] = [
  "agencies.read",
  "currencies.read",
  "currencies.write",
  "pricing.read",
  "pricing.write",
  "dashboard.view",
  // money side of the platform: wallet + invoices, no case editing
  "wallet.read",
  "wallet.write",
  "wallet.charge",
  "invoices.read",
  "invoices.write",
  "applications.read",
  "reports.read",
  "reports.export",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ALL,
  ADMIN: ALL.filter((p) => p !== "settings.write" || true), // admins manage business config + content
  VISA_AGENT,
  ACCOUNTING,
  AGENCY_ADMIN: [
    "agency_portal.access",
    "agencies.users.manage",
    "applications.read",
    "applications.write",
    "applications.submit",
    "documents.upload",
    "wallet.read",
    "invoices.read",
    "notifications.read",
    "communications.read",
    "communications.write",
    "reports.read",
  ],
  AGENCY_USER: [
    "agency_portal.access",
    "applications.read",
    "applications.write",
    "documents.upload",
    "wallet.read",
    "invoices.read",
    "notifications.read",
    "communications.read",
  ],
};

/** Server-side capability check. */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** Capability list for a role — exported so UI and tests can reason about the
 *  matrix without duplicating it. */
export function permissionsFor(role: Role): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

/** SUPER_ADMIN-only operations (e.g. editing security settings). */
export function isSuperAdmin(role: Role): boolean {
  return role === "SUPER_ADMIN";
}

export function isStaff(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

export function isAgencyMemberRole(role: Role): boolean {
  return AGENCY_ROLES.includes(role);
}

/** Throws when the role lacks the capability. Pure — safe for any layer. */
export function assertPermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    const err = new Error(`Missing permission: ${permission}`);
    err.name = "AuthorizationError";
    throw err;
  }
}
