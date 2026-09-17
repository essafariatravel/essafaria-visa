import { NextResponse } from "next/server";
import { completeConnect } from "@/lib/gmail";
import { readOAuthState } from "@/lib/oauth-state";
import { getSessionUser } from "@/lib/session";
import { describeDomainError } from "@/lib/ops";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/gmail/callback — Google's redirect target.
 *
 * The state is verified against a single-use signed cookie before any token
 * exchange happens, so a forged or replayed callback cannot link a mailbox.
 * Failures redirect with a generic message; provider detail stays server-side.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const error = url.searchParams.get("error");
  const connectionId = url.searchParams.get("connectionId") ?? state.split(".")[0] ?? "";
  if (error) return NextResponse.redirect(new URL("/admin/inbox?flash=" + encodeURIComponent("err:Gmail authorisation was cancelled"), req.url));
  if (!code || !state || !connectionId) {
    return NextResponse.redirect(new URL("/admin/inbox?flash=" + encodeURIComponent("err:Incomplete Gmail callback"), req.url));
  }
  const token = cookies().get(SESSION_COOKIE)?.value ?? user.id;
  const payload = readOAuthState(connectionId, state, token);
  if (!payload) {
    return NextResponse.redirect(new URL("/admin/inbox?flash=" + encodeURIComponent("err:The Gmail authorisation step expired or was tampered with — start again"), req.url));
  }
  try {
    await completeConnect({ connectionId, code, state, verifier: payload.verifier, actor: user });
    return NextResponse.redirect(new URL("/admin/inbox?flash=" + encodeURIComponent("ok:Mailbox connected"), req.url));
  } catch (err) {
    const { message } = describeDomainError(err);
    return NextResponse.redirect(new URL("/admin/inbox?flash=" + encodeURIComponent(`err:${message}`.slice(0, 300)), req.url));
  }
}
