import { NextResponse, type NextRequest } from "next/server";
import { sameSiteOrigin } from "@/lib/same-site";

/**
 * Edge layer: session presence, cross-site mutation refusal, a coarse burst
 * limiter and baseline response headers.
 *
 * This is defence in depth, NOT the security boundary — every page, server
 * action and API handler re-checks authentication, capability and tenancy
 * against the database. Nothing here grants access.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = req.cookies.get("esf_session")?.value;

  const publicApi = pathname === "/api/health" || pathname.startsWith("/api/auth/");
  const needsAuth =
    !publicApi &&
    (pathname.startsWith("/admin") || pathname.startsWith("/agency") || pathname.startsWith("/api/"));

  const method = req.method.toUpperCase();
  const mutating = ["POST", "PATCH", "PUT", "DELETE"].includes(method);

  if (mutating) {
    // Server actions are POSTs to the page path, so this covers the forms as
    // well as the JSON API. Combined with the httpOnly SameSite=Lax cookie, a
    // cross-site form cannot act as a signed-in user.
    const trustProxy = process.env.TRUST_PROXY_HEADERS !== "false";
    const guard = sameSiteOrigin(
      req.headers.get("origin"),
      req.url,
      req.headers.get("host"),
      trustProxy ? req.headers.get("x-forwarded-host") : null,
    );
    if (!guard.ok) {
      if (pathname.startsWith("/api/")) {
        return withSecurityHeaders(NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 }));
      }
      return withSecurityHeaders(new NextResponse("Cross-origin request blocked", { status: 403 }));
    }
    if (!limiterAllows(req)) {
      const headers = new Headers({ "Retry-After": "60" });
      if (pathname.startsWith("/api/")) {
        return withSecurityHeaders(NextResponse.json({ error: "Too many requests" }, { status: 429, headers }));
      }
      return withSecurityHeaders(new NextResponse("Too many requests — slow down", { status: 429, headers }));
    }
  }

  if (needsAuth && !session) {
    if (pathname.startsWith("/api/")) {
      return withSecurityHeaders(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `next=${encodeURIComponent(pathname)}`;
    return withSecurityHeaders(NextResponse.redirect(url));
  }

  return withSecurityHeaders(NextResponse.next());
}

const CSP_REPORT_ONLY =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

/** Baseline headers on every response the middleware touches. The public site
 *  is additionally covered by next.config headers(), which applies globally. */
function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("X-DNS-Prefetch-Control", "off");
  // Report-Only on purpose: Next injects inline bootstrap scripts, so an
  // enforcing CSP needs nonces first (upgrade path in DEPLOYMENT.md).
  res.headers.set("Content-Security-Policy-Report-Only", CSP_REPORT_ONLY);
  return res;
}

/**
 * Per-process token bucket keyed by client IP and route prefix.
 *
 * KNOWN LIMITATION, stated plainly: without a shared store (Redis) this only
 * throttles a single instance. It is here to stop one worker being hammered, not
 * to be a distributed rate limiter.
 */
function limiterAllows(req: NextRequest): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "local";
  const key = `${ip}:${req.nextUrl.pathname.split("/").slice(0, 3).join("/")}`;
  return bucketAllowed(key, Number(process.env.RATE_LIMIT_PER_MINUTE ?? 240));
}

const buckets = new Map<string, { tokens: number; at: number }>();

function bucketAllowed(key: string, perMinute: number): boolean {
  const now = Date.now();
  const capacity = Math.max(1, perMinute) * 2;
  const hit = buckets.get(key);
  if (!hit) {
    buckets.set(key, { tokens: capacity - 1, at: now });
    if (buckets.size > 4000) for (const [k, v] of buckets) if (now - v.at > 300_000) buckets.delete(k);
    return true;
  }
  const refilled = Math.min(capacity, hit.tokens + ((now - hit.at) * Math.max(1, perMinute)) / 60_000);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, at: now });
    return false;
  }
  buckets.set(key, { tokens: refilled - 1, at: now });
  return true;
}

export const config = {
  // Everything except build assets: the public site gets the same baseline
  // headers and the same cross-origin protection on its form posts.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
