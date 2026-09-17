import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { can, type Permission } from "@/lib/rbac";
import { buildActor, buildStaffActor, isStaffRole, type OpActor } from "@/lib/guard";
import { resolveAgencyContext } from "@/lib/tenancy";

/* ============================================================
 * Page-level actor resolution.
 *
 * Pages are server components, so they cannot "return 403" the way an API can:
 * they redirect. The check is still real — the data loaders below every page
 * re-authorise, and the mutation services authorise again on submit.
 * ============================================================ */

async function session() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/** Agency portal (or shared) page actor. Agencies are pinned to their own
 *  membership; staff may carry an explicit agency selection. */
export async function opActorForPage(permission: Permission): Promise<OpActor> {
  const user = await session();
  if (!can(user.role, permission)) redirect("/login?error=forbidden");
  const acting = await resolveAgencyContext(user);
  try {
    return buildActor(user, permission, { onBehalfOfAgencyId: acting });
  } catch {
    // no agency linked: the portal has nothing to show
    return buildActor(user, permission);
  }
}

/**
 * Back-office page actor.
 *
 * Two checks, and the second one is the real boundary:
 *   1. role membership in the staff group — decided here so that a partner who
 *      happens to hold the same *permission* (agency admins are granted ai.use,
 *      reports.read and others on purpose) gets a clean redirect instead of an
 *      exception rendered as a broken page;
 *   2. buildStaffActor(), which refuses a non-staff role again and is what every
 *      mutation and loader behind this page re-verifies.
 * Hiding the link in the nav is never the boundary.
 */
export async function staffActorForPage(permission: Permission, agencyId?: string | null): Promise<OpActor> {
  const user = await session();
  if (!can(user.role, permission) || !isStaffRole(user.role)) redirect("/login?error=forbidden");
  return buildStaffActor(user, permission, { agencyId: agencyId ?? null });
}
