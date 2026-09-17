import { z } from "zod";
import { NextResponse } from "next/server";
import { opRoute, ok } from "@/lib/api-ops";
import { createConnection, listConnections } from "@/lib/gmail";

export const dynamic = "force-dynamic";

/** GET /api/gmail/connections — connection status only. No scopes beyond what
 *  the operator configured, no addresses of third parties, no token material. */
export const GET = opRoute({ permission: "gmail.connect", allowAgency: false }, async () => {
  return ok({ connections: await listConnections() });
});

const body = z.object({ label: z.string().trim().min(2).max(80), emailAddress: z.string().trim().email().max(254) });

export const POST = opRoute({ permission: "gmail.manage", staffOnly: true, allowAgency: false, schema: body }, async ({ actor, body: b }) => {
  const parsed = body.parse(b);
  const id = await createConnection(actor, parsed.label, parsed.emailAddress);
  return NextResponse.json({ id }, { status: 201 });
});
