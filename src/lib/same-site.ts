/**
 * Same-site check for mutating requests — dependency-free so the Edge middleware
 * and the Node route layer can share ONE implementation and cannot disagree.
 *
 * Why hostname, not the full origin string: cookies are not port-scoped, so a
 * page on another port of the same host is exactly the case that must still
 * work (SameSite governs it), while a different host is the case that must fail.
 * Comparing raw origin strings also breaks behind TLS proxies that rewrite the
 * port — which turns a security control into an outage.
 *
 * A missing Origin is not treated as an attack: browsers always send Origin on
 * cross-site POSTs, and same-origin XHR/fetch from a page does too.
 *
 * Proxy awareness: behind a reverse/TLS/edge proxy the request that reaches this
 * process can carry a rewritten Host while the browser's Origin still names the
 * public host. Without consulting `X-Forwarded-Host` (set by the proxy, not the
 * page) every mutation from the public URL would be refused — a security control
 * turning into an outage. Accepting it is not a CSRF bypass: `X-Forwarded-Host`
 * is not a CORS-safelisted header, so a cross-site page cannot set it without a
 * preflight, and this app sends no permissive CORS headers. Deployments reachable
 * without a stripping proxy should set `TRUST_PROXY_HEADERS=false`.
 */
export function sameSiteOrigin(
  originHeader: string | null | undefined,
  requestUrl: string,
  hostHeader?: string | null,
  forwardedHostHeader?: string | null,
): { ok: boolean; reason?: string } {
  if (!originHeader) return { ok: true };
  let source: URL;
  let target: URL;
  try {
    source = new URL(originHeader);
    target = new URL(requestUrl, "http://localhost");
  } catch {
    return { ok: false, reason: "malformed-origin" };
  }
  const accepted = new Set<string>([target.hostname, target.host]);
  for (const candidate of [hostHeader, forwardedHostHeader]) {
    if (!candidate) continue;
    // A proxy chain may append several values; the leftmost is the client-facing
    // one. Proxies also disagree about whether to include the scheme, so normalise.
    for (const raw of (candidate.split(",")[0] ?? "").trim().split("\n")) {
      const value = raw.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
      if (!value) continue;
      accepted.add(value);
      const withoutPort = value.split(":")[0] ?? "";
      if (withoutPort) accepted.add(withoutPort);
    }
  }
  if (accepted.has(source.hostname) || accepted.has(source.host)) return { ok: true };
  return { ok: false, reason: "cross-origin" };
}

export function isMutatingMethod(method: string): boolean {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase());
}
