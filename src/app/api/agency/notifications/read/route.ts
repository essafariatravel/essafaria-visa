import { z } from "zod";
import { NextResponse } from "next/server";
import { opRoute } from "@/lib/api-ops";
import { markAllRead, markNotificationRead } from "@/lib/notifications";

export const dynamic = "force-dynamic";

const body = z.object({ id: z.string().trim().max(64).optional(), all: z.coerce.boolean().optional() });

/** POST /api/agency/notifications/read — a user can only mark their own. */
export const POST = opRoute({ permission: "notifications.read", agencyFrom: "none", schema: body }, async ({ user, body: b }) => {
  const parsed = body.safeParse(b ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues.map((i) => i.message) }, { status: 422 });
  if (parsed.data.all) {
    const n = await markAllRead({ id: user.id, agencyIds: user.agencyIds });
    return NextResponse.json({ marked: n });
  }
  if (!parsed.data.id) return NextResponse.json({ error: "id or all is required" }, { status: 422 });
  const changed = await markNotificationRead({ id: parsed.data.id, userId: user.id, agencyIds: user.agencyIds });
  return NextResponse.json({ marked: changed ? 1 : 0 }, { status: changed ? 200 : 409 });
});
