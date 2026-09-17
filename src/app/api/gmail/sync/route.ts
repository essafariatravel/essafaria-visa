import { z } from "zod";
import { NextResponse } from "next/server";
import { opRoute } from "@/lib/api-ops";
import { syncInbox } from "@/lib/gmail";
import { describeDomainError } from "@/lib/ops";

export const dynamic = "force-dynamic";

const body = z.object({ connectionId: z.string().trim().min(1).max(64), max: z.coerce.number().int().min(1).max(50).default(15) });

/** POST /api/gmail/sync — pull and ingest. Idempotent: re-running on the same
 *  mailbox stores nothing twice. */
export const POST = opRoute({ permission: "gmail.manage", staffOnly: true, allowAgency: false, schema: body }, async ({ actor, body: b }) => {
  const parsed = body.parse(b);
  try {
    const res = await syncInbox(actor, parsed.connectionId, { max: parsed.max });
    return NextResponse.json(res);
  } catch (err) {
    const { status, message } = describeDomainError(err);
    return NextResponse.json({ error: message }, { status });
  }
});
