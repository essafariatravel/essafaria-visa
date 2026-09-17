import { NextResponse } from "next/server";
import { opRoute } from "@/lib/api-ops";
import { beginConnect } from "@/lib/gmail";
import { writeOAuthState } from "@/lib/oauth-state";
import { SESSION_COOKIE } from "@/lib/session";
import { describeDomainError } from "@/lib/ops";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

/**
 * POST /api/gmail/connect?connectionId=… — start the OAuth flow.
 * Returns the authorisation URL (and redirects when asked) after arming the
 * single-use signed state cookie.
 */
export const POST = opRoute({ permission: "gmail.connect" }, async ({ actor, req }) => {
  const connectionId = new URL(req.url).searchParams.get("connectionId") ?? "";
  if (!connectionId) return NextResponse.json({ error: "connectionId is required" }, { status: 422 });
  try {
    const { url, state, verifier } = await beginConnect(actor, connectionId);
    const token = cookies().get(SESSION_COOKIE)?.value ?? actor.id;
    writeOAuthState({ connectionId, state, verifier }, token);
    const wantsRedirect = new URL(req.url).searchParams.get("redirect") === "1";
    if (wantsRedirect) return NextResponse.redirect(url, 302);
    return NextResponse.json({ url, state });
  } catch (err) {
    const { status, message } = describeDomainError(err);
    return NextResponse.json({ error: message }, { status });
  }
});
