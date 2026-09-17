import { z } from "zod";
import { ok, opRoute } from "@/lib/api-ops";
import { reviewDocument } from "@/lib/documents";

export const dynamic = "force-dynamic";

const body = z.object({
  decision: z.enum(["ACCEPT", "REJECT", "NEEDS_REPLACEMENT"]),
  note: z.string().trim().max(2000).optional(),
  rejectionCode: z.string().trim().max(40).optional(),
  requireValidityDays: z.coerce.number().int().min(0).max(3650).optional(),
});

/** POST /api/documents/[id]/review — staff only. The decision, its audit row,
 *  the checklist recomputation and the agency notification are atomic. */
export const POST = opRoute(
  { permission: "applications.review", staffOnly: true, allowAgency: false, schema: body },
  async ({ actor, params, body: b }) => {
    const parsed = body.parse(b);
    await reviewDocument(actor, params.id, {
      decision: parsed.decision,
      note: parsed.note ?? null,
      rejectionCode: parsed.rejectionCode ?? null,
      requireValidityDays: parsed.requireValidityDays ?? null,
    });
    return ok({ reviewed: true, decision: parsed.decision });
  },
);
