import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { draftReply } from "@/lib/gmail";

export const dynamic = "force-dynamic";

const body = z.object({ body: z.string().trim().min(10).max(20000) });

/**
 * POST /api/gmail/messages/[id]/draft — create a DRAFT in the connected
 * mailbox. There is no send path in this platform: a human reviews and sends.
 */
export const POST = opRoute({ permission: "communications.write", staffOnly: true, allowAgency: false, schema: body }, async ({ actor, params, body: b }) => {
  const parsed = body.parse(b);
  return ok(await draftReply(actor, { messageId: params.id, body: parsed.body }));
});
