import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { transitionStatus } from "@/lib/applications";

export const dynamic = "force-dynamic";

const body = z.object({
  toStatusCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,29}$/),
  reason: z.string().trim().max(2000).optional(),
  /** Staff-only, and only honoured when the role holds applications.override. */
  forceOverride: z.coerce.boolean().optional(),
});

/** POST /api/applications/[id]/status — move the file. The state machine, the
 *  document gate and the override rules all live in the service. */
export const POST = opRoute({ permission: "applications.submit", schema: body }, async ({ actor, params, body: b }) => {
  const parsed = body.parse(b);
  const result = await transitionStatus(actor, params.id, {
    toStatusCode: parsed.toStatusCode,
    reason: parsed.reason ?? null,
    forceOverride: parsed.forceOverride,
  });
  return ok(result);
});
