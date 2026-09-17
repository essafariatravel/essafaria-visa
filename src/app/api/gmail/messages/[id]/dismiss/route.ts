import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { dismissInbound } from "@/lib/gmail";

export const dynamic = "force-dynamic";

const body = z.object({ note: z.string().trim().max(500).optional() });

export const POST = opRoute({ permission: "applications.review", staffOnly: true, allowAgency: false, schema: body }, async ({ actor, params, body: b }) => {
  const parsed = body.parse(b ?? {});
  await dismissInbound(actor, params.id, parsed.note ?? null);
  return ok({ dismissed: true });
});
