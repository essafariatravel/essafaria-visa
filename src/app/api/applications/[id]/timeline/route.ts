import { opRoute, ok } from "@/lib/api-ops";
import { listTimeline } from "@/lib/applications";

export const dynamic = "force-dynamic";

/** GET /api/applications/[id]/timeline — staff see everything; agencies see the
 *  rows explicitly marked customer-visible. */
export const GET = opRoute({ permission: "applications.read" }, async ({ actor, params }) => {
  const rows = await listTimeline(actor, params.id, { customerView: !actor.isStaff });
  return ok({ entries: rows });
});
