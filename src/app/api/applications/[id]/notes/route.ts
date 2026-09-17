import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { appendNote } from "@/lib/applications";

export const dynamic = "force-dynamic";

const body = z.object({
  body: z.string().trim().min(2).max(8000),
  customerVisible: z.coerce.boolean().default(false),
});

/** POST /api/applications/[id]/notes — internal by default; only staff can
 *  write an internal note, and only staff can make one agency-visible. */
export const POST = opRoute({ permission: "applications.write", schema: body }, async ({ actor, params, body: b }) => {
  const parsed = body.parse(b);
  await appendNote(actor, params.id, { body: parsed.body, customerVisible: parsed.customerVisible });
  return ok({ saved: true });
});
