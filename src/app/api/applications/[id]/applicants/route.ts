import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { listApplicants, upsertApplicant } from "@/lib/applicants";
import { applicantUpsertSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = opRoute({ permission: "applications.read" }, async ({ actor, params }) => {
  return ok({ applicants: await listApplicants(actor, params.id) });
});

/** POST /api/applications/[id]/applicants — add a traveller. The file's tenant
 *  and its open slots come from the database, not from the request. */
export const POST = opRoute(
  { permission: "applications.write", schema: applicantUpsertSchema },
  async ({ actor, params, body }) => {
    const data = applicantUpsertSchema.parse(body) as never;
    const created = await upsertApplicant(actor, params.id, data);
    return ok(created, 201);
  },
);
