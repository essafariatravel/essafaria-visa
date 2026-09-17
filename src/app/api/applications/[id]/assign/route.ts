import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { assignCaseOfficer } from "@/lib/applications";

export const dynamic = "force-dynamic";

const body = z.object({ userId: z.string().trim().max(64).nullable().optional() });

/** POST /api/applications/[id]/assign — staff only. */
export const POST = opRoute(
  { permission: "applications.assign", staffOnly: true, allowAgency: false, schema: body },
  async ({ actor, params, body: b }) => {
    const parsed = body.parse(b ?? {});
    await assignCaseOfficer(actor, params.id, parsed.userId ?? null);
    return ok({ assigned: parsed.userId ?? null });
  },
);
