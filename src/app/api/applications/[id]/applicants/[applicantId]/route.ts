import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { removeApplicant, upsertApplicant } from "@/lib/applicants";
import { applicantUpsertSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** PATCH — update. The [applicantId] ⇄ [id] ⇄ agency relationship is re-proved
 *  from the database inside the writing transaction; a forged pair 404s. */
export const PATCH = opRoute(
  { permission: "applications.write", schema: applicantUpsertSchema },
  async ({ actor, params, body }) => {
    const data = applicantUpsertSchema.parse(body) as never;
    await upsertApplicant(actor, params.id, data, params.applicantId);
    return ok({ saved: true });
  },
);

export const DELETE = opRoute({ permission: "applications.write" }, async ({ req, actor, params }) => {
  const reason = new URL(req.url).searchParams.get("reason") ?? undefined;
  await removeApplicant(actor, params.id, params.applicantId, reason);
  return ok({ removed: true });
});
