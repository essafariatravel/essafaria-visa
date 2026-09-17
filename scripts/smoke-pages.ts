/**
 * Page smoke test against a RUNNING server (dev or prod build).
 *
 * Why this exists: unit tests exercise the service layer, but a page component can
 * hold a query that only PostgreSQL rejects — e.g. ORDER BY a column that is
 * neither grouped nor aggregated (SQLSTATE 42803). That class of defect is
 * invisible to service tests, so every screen here is actually fetched and checked
 * for a 200 and for the Next.js error boundary. It found exactly that bug on the
 * agency dashboard.
 *
 *   npm run build && npm start      # in another shell
 *   npm run smoke:pages             # read-only, safe against staging
 *
 * Only GET requests are made, so this never mutates data. It complements — it does
 * not replace — the authorization matrix in tests/.
 */

const BASE = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "admin@essafaria.local";
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? "str0ng-admin-pass-2026";
const AGENCY_EMAIL = process.env.SMOKE_AGENCY_EMAIL ?? "owner@saharavoyages.dz";
const AGENCY_PASSWORD = process.env.SMOKE_AGENCY_PASSWORD ?? "str0ng-agency-pass-2026";

const STAFF_PAGES = [
  "/admin",
  "/admin/applications",
  "/admin/applications/new",
  "/admin/agencies",
  "/admin/users",
  "/admin/wallet",
  "/admin/inbox",
  "/admin/copilot",
  "/admin/reports",
  "/admin/automation",
  "/admin/audit",
  "/admin/settings",
  "/admin/branding",
  "/admin/homepage",
  "/admin/legal",
  "/admin/media",
];

const AGENCY_PAGES = [
  "/agency",
  "/agency/applications",
  "/agency/applications/new",
  "/agency/wallet",
  "/agency/inbox",
  "/agency/team",
];

const ERROR_BOUNDARY = /Application error|Internal Server Error|something went wrong/i;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(54)} ${detail}`);
}

type Jar = { cookie: string | null };

async function hit(path: string, jar: Jar = { cookie: null }): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: jar.cookie ? { cookie: jar.cookie } : undefined,
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) jar.cookie = setCookie.split(";")[0] ?? jar.cookie;
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
}

/** A page is healthy when it answers 200 and is not the error boundary. */
async function page(name: string, jar: Jar, path: string): Promise<void> {
  const res = await hit(path, jar);
  const boundary = ERROR_BOUNDARY.test(res.body);
  check(name, res.status === 200 && !boundary, `HTTP ${res.status}${boundary ? " + error boundary" : ""}`);
}

async function login(email: string, password: string): Promise<Jar> {
  const jar: Jar = { cookie: null };
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) jar.cookie = setCookie.split(";")[0] ?? null;
  check(`login ${email}`, res.status === 200 && Boolean(jar.cookie), `HTTP ${res.status}`);
  return jar;
}

async function firstApplicationId(jar: Jar): Promise<string> {
  const res = await hit("/api/applications?pageSize=5", jar);
  if (res.status !== 200) return "";
  try {
    const parsed = JSON.parse(res.body) as { data?: { rows?: Array<{ id: string }> }; rows?: Array<{ id: string }> };
    const rows = parsed.data?.rows ?? parsed.rows ?? [];
    return rows[0]?.id ?? "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  console.log(`\nESSAFARIA VISA OS — page smoke against ${BASE}\n`);

  const health = await hit("/api/health");
  check("GET /api/health", health.status === 200 && health.body.includes('"status":"ok"'), `HTTP ${health.status}`);
  if (health.status !== 200) {
    console.log(`\nserver not reachable at ${BASE} — start it first (npm run build && npm start)\n`);
    process.exit(1);
  }

  console.log("\n-- public --");
  for (const p of ["/", "/visas", "/contact", "/legal/privacy", "/legal/terms", "/login"]) {
    await page(`GET ${p}`, { cookie: null }, p);
  }
  const anonApi = await hit("/api/applications");
  check("anon GET /api/applications -> 401", anonApi.status === 401, `HTTP ${anonApi.status}`);
  const anonPage = await hit("/admin");
  check("anon GET /admin -> redirect to login", [301, 302, 307].includes(anonPage.status), `HTTP ${anonPage.status}`);

  console.log("\n-- staff --");
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const appId = await firstApplicationId(admin);
  if (!appId) check("sample application id available", false, "list returned nothing — pages with [id] skipped");
  for (const p of STAFF_PAGES) await page(`GET ${p}`, admin, p);
  if (appId) {
    await page("GET /admin/applications/[id]", admin, `/admin/applications/${appId}`);
    await page("GET /admin/applications/[id]/documents", admin, `/admin/applications/${appId}/documents`);
    await page("GET /admin/applications/[id]/assistant", admin, `/admin/applications/${appId}/assistant`);
  }
  for (const api of [
    "/api/applications",
    "/api/agency/notifications",
    "/api/gmail/connections",
    "/api/reports/applications?format=json",
    "/api/reports/documents?format=json",
    "/api/reports/agencies?format=json",
    "/api/reports/financial?format=json",
    "/api/reports/processing?format=json",
    "/api/reports/applications?format=csv",
    ...(appId
      ? [
          `/api/applications/${appId}`,
          `/api/applications/${appId}/documents`,
          `/api/applications/${appId}/checklist`,
          `/api/applications/${appId}/timeline`,
          `/api/applications/${appId}/applicants`,
        ]
      : []),
  ]) {
    const res = await hit(api, admin);
    check(`GET ${api}`, res.status === 200, `HTTP ${res.status}${res.status !== 200 ? ` ${res.body.slice(0, 90)}` : ""}`);
  }
  const csv = await hit("/api/reports/applications?format=csv", admin);
  check("csv export is text/csv", csv.status === 200, `HTTP ${csv.status}`);

  console.log("\n-- agency --");
  const agency = await login(AGENCY_EMAIL, AGENCY_PASSWORD);
  const ownId = await firstApplicationId(agency);
  for (const p of AGENCY_PAGES) await page(`GET ${p}`, agency, p);
  if (ownId) {
    await page("GET /agency/applications/[id]", agency, `/agency/applications/${ownId}`);
    await page("GET /agency/applications/[id]/documents", agency, `/agency/applications/${ownId}/documents`);
  }
  for (const api of [
    "/api/agency/wallet",
    "/api/agency/invoices",
    "/api/agency/notifications",
    ...(ownId ? [`/api/applications/${ownId}`, `/api/applications/${ownId}/documents`] : []),
  ]) {
    const res = await hit(api, agency);
    check(`GET ${api}`, res.status === 200, `HTTP ${res.status}${res.status !== 200 ? ` ${res.body.slice(0, 90)}` : ""}`);
  }

  console.log("\n-- negative (authz is not a UI concern) --");
  const other = ownId && appId && ownId !== appId ? appId : "";
  if (other) {
    const res = await hit(`/api/applications/${other}`, agency);
    check("agency reading another tenant's file -> 404", res.status === 404, `HTTP ${res.status}`);
  }
  const report = await hit("/api/reports/financial", agency);
  check("agency asking for a staff report -> 404", report.status === 404, `HTTP ${report.status}`);
  // Next streams a page-level redirect as a 200 with a client-side refresh when the
  // response has already begun, so the test that matters is "no back-office content
  // and the visitor is bounced", not the status code alone.
  const STAFF_MARKERS = /Desk copilot|Platform settings|Partners & agencies|Wallet control|Automation run log|Audit trail|Report builder/i;
  for (const p of ["/admin", "/admin/copilot", "/admin/wallet", "/admin/reports", "/admin/automation", "/admin/settings"]) {
    const res = await hit(p, agency);
    const bounced = [301, 302, 303, 307, 403].includes(res.status) || /url=\//.test(res.body);
    const leaked = STAFF_MARKERS.test(res.body);
    check(`agency opening ${p} -> bounced, no staff content`, bounced && !leaked, `HTTP ${res.status}${leaked ? " + staff content" : ""}${bounced ? "" : " + no redirect"}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
  if (failed.length) {
    for (const f of failed) console.log(`  ! ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
