import { opRoute, ok } from "@/lib/api-ops";
import { getChecklist, publicChecklistBundle } from "@/lib/applications";

export const dynamic = "force-dynamic";

/** GET /api/applications/[id]/checklist — derived from the file's frozen
 *  requirement snapshot ∩ live document state (never a stored copy). */
export const GET = opRoute({ permission: "applications.read" }, async ({ actor, params }) => {
  const bundle = await getChecklist(actor, params.id);
  return ok(publicChecklistBundle(actor, bundle));
});
