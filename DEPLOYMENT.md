# Deployment & operations guide

Everything here is what a real deployment has to know. Where something was **not**
exercised in the build environment, it says so — do not read an unverified line as a
passing test.

---

## 1. Configuration model

Two kinds of configuration, deliberately separated:

| Kind | Where it lives | Changed by |
|---|---|---|
| **Business configuration** — countries, visa types, requirements, fees, statuses, priorities, currencies, templates, branding, pages, ops flags (`ops.*`), AI/Gmail settings (`ai.*`, `gmail.*`) | PostgreSQL, edited in Admin → Settings / catalog screens | Admins, at runtime. Nothing here needs a deploy |
| **Infrastructure** — database target, media root, transport selection, secrets **references** | `process.env`, template in `.env.example` | Operators, at deploy time |

`.env.example` names variables and reference keys only. Secret *values* never enter
the repository (`npm run secrets:scan` enforces that on tracked files).

Strictness note: `src/lib/env.ts` parses env with a closed schema — an undeclared
variable is dropped rather than passed through. When adding a setting, declare it
there too, or the app will silently ignore what the operator set.

---

## 2. Database

```bash
DATABASE_URL=postgresql://user:pass@host:5432/essafaria   # production
npm run db:migrate        # applies drizzle/*.sql, records what ran
npm run db:seed           # idempotent: inserts missing config, never overwrites edits
```

- **PostgreSQL is the only supported production database.** PGlite
  (`DATABASE_MODE=pglite`) is the embedded engine used for this sandbox and for tests;
  it is single-writer per data directory (see `src/lib/pglite-writer-lock.ts`).
- Migrations are additive and reversible in effect: new tables/columns/indexes only,
  nothing destructive; business meaning is preserved through **snapshots** (each file
  freezes the requirements + pricing it was opened under) and **effective-dated** fees,
  so a reprice never rewrites history.
- Money is `bigint` minor units end to end. No floats, no rounding drift. There is a
  reconciliation report (`/api/reports/financial`, or Admin → Reports) that compares
  each wallet header against its ledger sum; a mismatch is surfaced as a row, and the
  `reconcile-wallets` automation task repairs header drift from the ledger, never the
  reverse.
- Concurrency uses PostgreSQL semantics: `SELECT … FOR UPDATE` for sequence/ledger
  claims, conditional `UPDATE … WHERE state = 'PENDING'` for idempotent transitions,
  an atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` for the
  outbox queue, partial unique indexes for "one current version per document".
- **The production driver is exercised, not assumed.** The whole suite runs against an
  embedded PostgreSQL *server* (separate connections through `pg`, not PGlite):

  ```bash
  TEST_DB=postgres DATABASE_URL=postgresql://… npm run test:postgres   # 183 tests
  DATABASE_MODE=postgres DATABASE_URL=postgresql://… npm run verify:concurrency
  ```

  `verify:concurrency` is the contention evidence the old draft of this file said was
  missing. It races 24 application creates, 20 wallet charges, 6 outbox dispatchers and
  10 document uploads on a real server and asserts 9 invariants (unique gap-free
  reference numbers, one debit row and one balance movement, no email sent twice, one
  current document version). It exits non-zero if any of them breaks, and it refuses to
  run against PGlite, because PGlite would not be showing you the contention.
  Verified here on PostgreSQL 18.4: 9/9. It also caught the one real defect of this
  pass — the outbox used to claim rows with a `SELECT … FOR UPDATE` and update them in
  a *separate* autocommit statement, so the lock died before the send and two
  schedulers emailed the same customer twice (regression test: "claims a delivery
  atomically so two dispatchers cannot send the same message").

---

## 3. Background jobs

```bash
npm run outbox:drain      # claim + deliver queued email intents
npm run automation:run    # run every task whose interval has elapsed
AUTOMATION_TASK=daily-digest AUTOMATION_FORCE=1 npm run automation:run   # one task now
```

Cron suggestion (idempotent, so overlap is safe — a claim is a single statement that
both marks the row and returns it, so a second worker cannot pick up the same message
while the first is still sending):

```cron
*/5 * * * * cd /srv/essafaria && npm run outbox:drain >> /var/log/essafaria-outbox.log 2>&1
*/10 * * * * cd /srv/essafaria && npm run automation:run >> /var/log/essafaria-automation.log 2>&1
```

Both exit non-zero on failure. Email delivery state, attempt counts and the next retry
are stored per delivery (`notification_deliveries`), and `/api/health` reports
`queued_deliveries`, `failed_deliveries` and `failed_task_runs` for alerting.

---

## 4. Outbound email

| `EMAIL_TRANSPORT` | Behaviour |
|---|---|
| `none` (default) | nothing is sent; intents are recorded as `SKIPPED` — the audit trail stays complete |
| `file` (and `log`, which resolves to the same transport) | each message is written to `MEDIA_ROOT/outbox/*.eml` — local inspection, no network |
| `smtp` | requires `SMTP_URL`; **not exercised live in this build** (see §9) |

Outbound is always driven by the outbox: a business write commits its intent in the
same transaction, and delivery happens outside it. A failed send never rolls back the
invoice or the note that triggered it.

---

## 5. Gmail intake (Phase 8)

```bash
GMAIL_PROVIDER=google
GMAIL_CLIENT_ID_REF=GMAIL_CLIENT_ID          # names of env vars, not the values
GMAIL_CLIENT_SECRET_REF=GMAIL_CLIENT_SECRET
GMAIL_TOKEN_KEY_REF=ESF_TOKEN_KEY            # AES-256-GCM key sealing refresh tokens
GMAIL_REDIRECT_URI=https://app.example.com/api/gmail/callback
```

- The `google` provider is a thin REST adapter (`src/lib/gmail-provider.ts`);
  `fixture` is a deterministic in-memory provider used by the tests.
- Idempotency: `(connection, messageId)` is unique, so re-syncing a mailbox never
  duplicates an application. Attachments are staged into the media library as
  `DOCUMENT`-kind candidates for a human to link — nothing is auto-applied to a file.
- Replies are created as **drafts** only. There is no send path.
- Revoking a connection clears sealed tokens; low-balance/security notifications are
  unaffected.
- **Not verified live:** no OAuth consent was run against Google, no mailbox polled.
  The flow is verified against the fixture provider, including state/nonce checks,
  token sealing round-trip, dedupe, and the "draft only" guarantee.

**Key rotation:** `ESF_TOKEN_KEY` seals stored refresh tokens. Set it as a secret and
back it up — losing it means every partner must reconnect Gmail. Rotating it requires
re-sealing (decrypt with the old key, encrypt with the new) before deployment.

---

## 6. AI assistant (Phase 9)

```bash
AI_PROVIDER=openai|anthropic|gemini|ollama|rules|none
AI_MODEL=gpt-…                                # whatever the vendor calls it
AI_API_KEY_REF=AI_API_KEY                     # name of the variable holding the key
AI_BASE_URL=                                  # only for proxies/Ollama/self-hosted
```

Hard boundaries, enforced in the service layer rather than in the prompt:

- The assistant **proposes**; a staff member disposes. Suggestions carry an accept/reject
  action that re-runs the same authorization and validation as any manual edit; nothing
  is written without it.
- It never returns an approval, refusal, eligibility verdict or a promise about a visa —
  those outputs are stripped and replaced with "a case officer decides this".
- It cannot invent fields: extraction output is validated against the applicant schema,
  and unknown/ambiguous values come back as questions, not data.
- It sees only what the requesting actor may already read (the prompt is assembled from
  the same tenant-scoped services the screens use), and cross-tenant ids resolve to 404.
- `rules` is the deterministic local provider — no network, useful for staging and
  tests. `AI_PROVIDER=none` turns the feature off and hides the affordances.
- **Not verified live:** no vendor API was called from this environment. Providers are
  covered by contract tests against a fake transport (timeouts, malformed JSON,
  over-long output, prompt-injection content in emails).

---

## 7. Security posture

- **Sessions:** httpOnly, SameSite=Lax, secure-in-production cookies; token = sha256 of
  the random session id stored in DB; lifetime from `security.sessionDays`; changing a
  password or deactivating a user revokes their sessions.
- **Authorization:** server-side in every page, action and route (`src/lib/guard.ts`,
  `src/lib/ops.ts`). Hiding a nav link is never the boundary. A staff-only *page*
  additionally checks the role group, so a partner holding a shared permission
  (e.g. `reports.read`) is redirected instead of rendering a broken screen;
  `tests/page-guard.test.ts` pins that.
- **Tenant isolation:** derived from session memberships, never from the request body
  or URL. Cross-tenant ids answer 404 — the same answer as a typo — so the API cannot
  be used as an existence oracle.
- **CSRF:** same-site origin check shared by the Edge middleware and the Node route
  layer (`src/lib/same-site.ts`), covering server actions as well as JSON. Behind a
  proxy that rewrites `Host`, the check accepts `X-Forwarded-Host`; if nothing
  trustworthy fronts the app, set `TRUST_PROXY_HEADERS=false`.
- **Throttles:** per-email login attempts (`LOGIN_MAX_ATTEMPTS`, default 8 per
  `LOGIN_WINDOW_MINUTES`) with an identical response for unknown vs wrong password, and a
  per-IP token bucket for mutations (`RATE_LIMIT_PER_MINUTE`, default 240). Both are
  **per-process** — one shared Redis/Upstash store is needed to make them global across
  instances; that is not implemented and not claimed.
- **Headers:** `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and a
  **report-only** CSP. To enforce it, move the policy from
  `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in
  `src/middleware.ts` + `next.config.mjs` after switching inline styles/scripts to
  nonces — the current CSP would block Next's own bootstrap otherwise.
- **Media:** uploaded bytes are served through an authenticated route with
  `no-store`; the public `/api/media/[id]` route refuses document-kind objects.
  Put `MEDIA_ROOT` on durable storage (S3-compatible mount or a shared volume) — the
  local provider stores plain files, and the DB holds metadata only.

---

## 8. Go-live checklist

1. `DATABASE_URL` to managed Postgres; `npm run db:migrate && npm run db:seed`
   (seed is idempotent: 273 config rows on an empty DB, 0 inserted + 273 skipped on a
   second run).
2. Set `SEED_*_PASSWORD` for the first boot, then **deactivate** the seeded accounts
   in Admin → Users and create named ones.
   (`npm run db:demo` exists for staging only — sample files through the real services, so
   a reviewer can see the lifecycle; production never runs it.)
3. Set `ESF_TOKEN_KEY` (`openssl rand -base64 32` — it seals Gmail tokens, and
   rotating it forces every mailbox to reconnect), `APP_URL`, `MEDIA_ROOT`,
   `EMAIL_TRANSPORT=smtp` (+ provider credentials), `AI_PROVIDER`, `GMAIL_*` as needed.
   `REQUIRE_HTTPS` / `TRUST_PROXY_HEADERS` / `GMAIL_ENABLED` are the **strings**
   `true`/`false`; `1`/`0` fails the boot-time env schema on purpose.
   **Every process must share one `MEDIA_ROOT`** — the web server, the outbox worker and
   any one-off script. A CLI run with a different media root writes the row in the
   database and the bytes somewhere else, and the document then 404s on open.
4. `npm run deploy:check` against the production environment before starting. It parses
   the env exactly as the app does, connects, compares applied migrations with
   `drizzle/`, writes to the media root, and resolves the email/AI/Gmail providers the
   way the runtime does. Exit 1 means do not start.
5. `REQUIRE_HTTPS=true` behind TLS; confirm the proxy sends `X-Forwarded-Host`.
6. Add the two cron lines from §3; wire alerts to `/api/health`
   (`queued_deliveries`, `failed_deliveries`, `failed_task_runs`, `negative_wallets`).
7. Run `npm run smoke:pages` against the deployed URL
   (`SMOKE_BASE_URL=https://app.example.io SMOKE_ADMIN_PASSWORD=… npm run smoke:pages`).
8. Review the CSP report endpoint for a week, then switch it to enforcing.

---

## 9. Verified here / not verified here

| Claim | Status |
|---|---|
| Tests: 19 files / 183 passing, twice — once on embedded PGlite and once against a real PostgreSQL 18.4 server with every test file in its own database | **verified** (`npm test`, `npm run test:postgres`) |
| Typecheck, lint, production build (the build works with an empty environment — configuration is a runtime concern) | **verified** |
| HTTP behaviour, authz, tenancy, throttles, headers, CSV, media, outbox+automation CLIs | **verified** against `npm start` (`npm run probe:http`, 68 live checks) — and the same 68 against the deployed build on real PostgreSQL |
| Every authenticated screen renders for staff and for a partner, no SQL that only Postgres rejects | **verified** (`npm run smoke:pages`, 65 checks, also re-run against the PostgreSQL deployment) |
| Configuration-first: reprice, required-document toggle, processing time, priority surcharge, status graph, `ops.agencySelfSubmit`, template copy → reflected without code change; old files keep their snapshot | **verified** in `tests/platform-hardening.test.ts` |
| Multi-connection Postgres contention (many app instances) | **verified** — `npm run verify:concurrency`, 9/9 invariants on PostgreSQL 18.4 under 24/20/6/10-way contention |
| Outbox never sends the same message twice with two schedulers running | **verified** (atomic claim + regression test; the pre-fix code duplicated 7/7 sends in that test) |
| Preflight (`npm run deploy:check`) on both drivers | **verified** — 13 ok / 0 blocking on PostgreSQL, and it correctly blocks on a missing `DATABASE_URL` |
| Migrations + seed idempotency on a real server | **verified** — `7 of 7` applied, seed re-run `inserted=0 skipped=273` |
| `docker build` / `docker compose up` actually running | **not verified here** — no container runtime in this sandbox; the Dockerfile, `.dockerignore` and `docker-compose.yml` are reviewed and CI builds the image, but the first `docker compose up` is a first run |
| Live Gmail (Google REST, OAuth consent, polling) | **not verified** — fixture provider only |
| Live SMTP delivery | **not verified** — the queue is exercised; no provider client is installed in this build, so `EMAIL_TRANSPORT=smtp` needs `nodemailer` (or equivalent) added first |
| Remote AI vendors (OpenAI/Anthropic/Gemini/Ollama) | **not verified** — `rules` + fake transports |
| Browser-level interactive UX (click-through, JS state) | **not verified** — HTTP-level checks only |
| Enforced CSP, distributed rate limiting across instances | **not implemented as enforcing** (see §7) |

---

## 10. Containers, CI and the release path

```bash
cp .env.example .env && vi .env      # three values are required, the rest have defaults
docker compose up -d --build         # postgres 18 + the app
docker compose logs -f app           # preflight → migrations → server
docker compose --profile tools run --rm seed     # catalogue + demo accounts, staging only
```

What the image does: multi-stage `node:22-bookworm-slim`, non-root uid 1001, media on a
named volume, `HEALTHCHECK` on `/api/health` (which answers 503 while a subsystem is
degraded, so a green probe means usable, not merely listening). The entrypoint runs
`deploy:check`, then `migrate`, then starts — all three idempotent, which is what makes
"restart the container" a valid release procedure. Turn any of them off with
`RUN_DEPLOY_CHECK=0` / `RUN_MIGRATIONS=0` if your platform has a dedicated release
phase; `RUN_SEED=1` is for an empty staging database only.

CI lives at `ci/github-actions/ci.yml` — copy it to `.github/workflows/ci.yml` to
activate it (repository automation is usually not allowed to write to that directory, so
this repo ships it one step short of enabled). It runs on every push and pull request:

| Job | What it proves |
|---|---|
| `verify` | typecheck, lint, 183 tests on PGlite, production build, secret scan of everything git would commit |
| `postgres` (16 and 18) | the same suite against a real server, migrate + seed twice, `deploy:check`, `verify:concurrency`, then a running production server through `smoke:pages` and the 68-check `probe:http` |
| `image` | `docker build` of the release artefact and a `docker compose config` validation |

Deliberately absent: nothing pushes an image or deploys. Deploy stays a `docker compose
up` (or your platform's release phase) on a green pipeline, because the environments
and their secrets are not this repository's business.

Release order that avoids the sharp edges:

1. merge → tag → build the image
2. run migrations **before** rolling the new processes (migrations here are additive,
   so old and new code share the schema safely)
3. start the new processes, let the entrypoint preflight refuse a bad config
4. `SMOKE_BASE_URL=https://… npm run smoke:pages` against the deployment
5. only then: schedule the two cron jobs from §3 on the new host and disable the old
   ones — two schedulers are safe, but a drained queue on a host you are about to
   delete is just noise in the logs
