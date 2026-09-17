import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { getApplication, publicChecklistBundle, updateApplication } from "@/lib/applications";
import { getChecklist } from "@/lib/applications";
import { listApplicants } from "@/lib/applicants";

export const dynamic = "force-dynamic";

/** GET /api/applications/[id] — the file, its checklist and its travellers.
 *  Cross-tenant ids answer 404, exactly like a typo. */
export const GET = opRoute({ permission: "applications.read" }, async ({ actor, params }) => {
  const { view } = await getApplication(actor, params.id);
  const [checklist, applicants] = await Promise.all([getChecklist(actor, params.id), listApplicants(actor, params.id)]);
  return ok({ application: view, checklist: publicChecklistBundle(actor, checklist), applicants });
});

const patch = z.object({
  requestedCount: z.coerce.number().int().min(1).max(50).optional(),
  priorityId: z.string().trim().max(64).nullable().optional(),
  travelDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  caseOfficerUserId: z.string().trim().max(64).nullable().optional(),
  consulateRef: z.string().trim().max(120).nullable().optional(),
  staffNotes: z.string().trim().max(8000).nullable().optional(),
});

export const PATCH = opRoute({ permission: "applications.write", schema: patch }, async ({ actor, params, body }) => {
  await updateApplication(actor, params.id, patch.parse(body));
  return ok({ saved: true });
});
