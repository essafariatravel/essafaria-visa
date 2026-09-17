/** @type {import('next').NextConfig} */
/** Baseline response headers for every route, including static assets. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Report-Only by design: Next ships inline bootstrap scripts, so enforcing a
  // CSP without nonces would break the app. See DEPLOYMENT.md for the upgrade
  // path (nonce-based CSP via a middleware rewrite) once that is scheduled.
  {
    key: "Content-Security-Policy-Report-Only",
    value:
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // uploaded public media can be cached hard; applicant documents never go
      // through this route (they are served by /api/documents/[id]/content, no-store)
      { source: "/_next/static/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
  experimental: {
    // PGlite ships platform binaries + wasm; must not be bundled by webpack
    serverComponentsExternalPackages: ["@electric-sql/pglite"],
  },
};

export default nextConfig;
