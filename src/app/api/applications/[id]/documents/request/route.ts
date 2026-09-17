import { z } from "zod";
import { ok, opRoute } from "@/lib/api-ops";
import { requestMissingDocuments } from "@/lib/documents";

export const dynamic = "force-dynamic";

const body = z.object({ note: z.string().trim().max(2000).optional() });

/** POST /api/applications/[id]/documents/request — nudge the agency with the
 *  outstanding list. Notification + event + audit land in one transaction. */
export const POST = opRoute({ permission: "applications.write", schema: body }, async ({ actor, params, body: b }) => {
  const parsed = body.parse(b ?? {});
  return ok(await requestMissingDocuments(actor, params.id, parsed.note ?? null));
});
