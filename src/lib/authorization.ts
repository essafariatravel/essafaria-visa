import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/lib/session";
import { can, isStaff, type Permission, type Role } from "@/lib/rbac";

export class AuthorizationError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Server-side permission check for API routes / server actions.
 * Throws on failure — pages must never rely on hidden UI alone.
 */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthorizationError("Authentication required");
  if (!can(user.role, permission)) throw new AuthorizationError(`Missing permission: ${permission}`);
  return user;
}

/** Same checks, page-friendly: redirects to /login when signed out. */
export async function requirePermissionForPage(permission: Permission): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!can(user.role, permission)) redirect("/login?error=forbidden");
  return user;
}

export async function requireStaff(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user.role)) redirect("/agency");
  return user;
}

export function assertPermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new AuthorizationError(`Missing permission: ${permission}`);
}

/** Authenticated actor for service calls — entity permissions are
 * checked inside the services themselves (defense in depth). */
export async function resolveActor(): Promise<{ id: string; email: string; role: Role }> {
  const user = await getSessionUser();
  if (!user) throw new AuthorizationError("Authentication required");
  return { id: user.id, email: user.email, role: user.role };
}
