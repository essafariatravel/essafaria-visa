# Live UAT runbook

For anyone about to click through this build — a partner agency, a case officer, an
accountant, an admin. Every step states what should happen **and which layer enforces
it**, so a surprising result can be traced to the right place.

## Access

On a freshly reset sandbox, `npm run db:demo` (with the web process stopped, because
PGlite has one writer) fills the queues with five sample files spanning NEW → APPROVED,
so every screen in this runbook has something to look at. It creates data only through the
application's own services, so it also exercises the checklist, review and billing paths.

| Surface | URL | Notes |
|---|---|---|
| Public site | `/` · `/visas` · `/contact` · `/legal/*` | rendered from CMS tables; no login, no data leakage |
| Agency portal | `/agency` | partner role |
| Back office | `/admin` | staff role |
| JSON API | `/api/*` | same services, same authorization |

Accounts: the seeded ones in `src/db/seed.ts` (staff `admin@`, `ops@`, `finance@`
`@essafaria.local`; partner `owner@`/`agent@saharavoyages.dz`). Their passwords are the
`SEED_ADMIN_PASSWORD` / `SEED_AGENCY_PASSWORD` values in the local `.env` — they are
never written into this repo, and the go-live checklist says to deactivate those
accounts once named ones exist.

Sign in at `/login`. Sessions last `security.sessionDays` (Admin → Settings) and die on
a restart if `ESF_TOKEN_KEY` changes — it is pinned in `.env` here so restarting is safe.

## Scenario 1 — a partner opens a file

1. `/agency/applications/new` → pick a visa type, travellers = 2 → **file created** with
   a reference `ESF-2026-NNNNNN`. *Enforced by* `createApplication` (tenancy pinned to the
   session's membership, snapshot captured at this moment).
2. Add two travellers, one with an expired passport → **422** naming the field, no SQL, no
   stack. *Enforced by* zod schemas in `validation.ts` — the same schema runs in the service.
3. Submit without documents → **409** listing the missing items. The gate is computed, not
   trusted from the client (`checklistComplete` is recomputed inside the transaction).
4. Upload a `.txt` renamed `.pdf` → **422** (magic bytes sniffed). Upload a real PDF →
   version 1 `PENDING_REVIEW`, checklist item satisfied but not accepted.
5. Upload the same document type again → the previous version is superseded, still listed in
   the history, never deleted. *Enforced by* a partial unique index — one current row per slot.

**What the partner must NOT see:** staff notes, case officer name, consulate reference, the
pricing configuration snapshot, other agencies at all. Check the network tab — those keys are
absent from the JSON, not merely hidden (see `publicChecklistBundle`, `mapRow`).

## Scenario 2 — the desk processes it

1. `/admin/applications` → filter by status, open the file. Assign yourself as case officer.
2. Reject one document with a reason → the partner's checklist flips to `REJECTED`, the file
   returns to "waiting on documents", an email intent is queued (`SENT` locally to
   `.data/uploads/outbox/*.eml`).
3. Try an illegal transition (e.g. straight to `COMPLETED`) → **409**, and the allowed options
   come from the configured graph. *Nothing about the graph is in code.*
4. Accept all documents → gate opens → submit to consulate → mark outcome. Closing a file
   freezes travellers; adding one now returns **409**.
5. Every step above appears in `/admin/audit` (who, what, before/after) and in the file's
   timeline, written in the same transaction as the change.

## Scenario 3 — money

1. Admin → Wallet → fund the agency (manual credit only; there is no card payment in this
   product). Ledger is append-only — balances are never edited, only reversed.
2. Submitting a file charges the wallet per the frozen snapshot. Underfunded → the submission
   is blocked with a clear message, and a low-balance alert reaches the partner inbox.
3. Change a fee in Admin → Pricing, then open a **new** file: it prices at the new amount,
   the old file and its invoice keep the old amount. That is the snapshot guarantee.
4. Reverse a charge → a reversal row appears, the balance returns, the original row is intact.
5. Admin → Reports → Financial: the reconciliation section must show **no MISMATCH rows**
   (wallet header = sum of its ledger). The `reconcile-wallets` task repairs header drift from
   the ledger, never the other way round.

## Scenario 4 — configuration without code (the acceptance test)

Do all of this in the admin panel, with the app running — no editor, no restart:

| Change | Expected effect |
|---|---|
| Deactivate a visa type | gone from every option list; new files refused; existing files unaffected |
| Toggle a requirement to optional | new files' checklists shrink; existing files keep their frozen list |
| Change a status label / colour / order | renamed everywhere, history still readable |
| Remove a transition from the status graph | the button disappears and the API refuses it with 409 |
| Edit a communication template | the next email (and the AI draft) uses the new wording |
| Flip `ops.agencySelfSubmit` off | partners lose the submit path in UI **and** API |
| Change session days | new logins use the new lifetime |

If any of these requires a code change, that is a defect — report it as such.

## Scenario 5 — Gmail intake (fixture provider here)

`GMAIL_PROVIDER=fixture` in `.env` means a deterministic fake mailbox, so intake can be
tested offline: `/admin/inbox` shows messages, an attachment can be staged onto a file, and a
reply is created as a **draft** — verify no send button exists and no message leaves.
Live Google OAuth/SMTP needs real credentials (`DEPLOYMENT.md` §5) and has **not** been
exercised from this environment.

## Scenario 6 — AI assistant

`/admin/copilot` (and the per-file Assistant tab): ask "which files are waiting on documents?"
or "summarise ESF-2026-000001". Expect: data-backed answers, suggestions that need an explicit
accept, no verdicts about approval/eligibility, and never an invented traveller. With
`AI_PROVIDER=rules` it runs fully offline. Paste a prompt-injection attempt into an email or
note and confirm it is treated as content, not instructions.

## Automated checks behind all of this

```bash
npm run typecheck && npm run lint && npm test   # 19 files / 183 tests
npm run test:postgres                           # same suite against a real PostgreSQL server
npm run verify:concurrency                       # contention invariants (needs DATABASE_URL, refuses PGlite)
npm run deploy:check                             # what has to be true before a server may start
npm run build && npm start
npm run smoke:pages                             # every screen, both roles (65–66 checks; the count follows the demo data)
PROBE_ADMIN_PASSWORD=… PROBE_OWNER_PASSWORD=… PROBE_TENANT_B_PASSWORD=… \
PROBE_RATE_LIMIT_PER_MINUTE=600 npm run probe:http    # 68 HTTP checks; see below
npm run secrets:scan
```

`probe:http` sizes its rate-limit burst from `PROBE_RATE_LIMIT_PER_MINUTE` (must match the
target's `RATE_LIMIT_PER_MINUTE`, 240 by default; this repo's `.env` sets 600 for comfortable
manual testing). It needs `.data/probe.json` — run `npm run probe:seed` first. With `DATABASE_URL` set it
writes to that database (the deployment under test) and needs no special ordering; with
the embedded PGlite it must run while the web process is stopped, because PGlite has one
writer per data directory (`src/lib/pglite-writer-lock.ts`).

## Known limits of this environment

- Background jobs (`outbox:drain`, `automation:run`) cannot run while the app holds the
  embedded database — stop the app, run the job, start again. With `DATABASE_URL` pointed at
  real Postgres, they just run on a cron.
- Tasks claim once per day: re-running the same task the same day reports `skipped (already
  ran for …)`. Use `AUTOMATION_TASK=<name> AUTOMATION_FORCE=1` to force one.
- CSP is report-only; rate limits are per-process; seeded accounts are still active **in
  this sandbox on purpose**, so the runbook above can be followed. On a real deployment they
  must be deactivated (that step is item 2 of the go-live checklist in `DEPLOYMENT.md`).
  Each is listed with its upgrade path in `DEPLOYMENT.md`.
- Media files live under `MEDIA_ROOT` (`.data/uploads` here), *not* in the database. Any CLI
  that touches documents must run with the same `MEDIA_ROOT` as the web process, or it will
  write a row whose bytes the running server cannot find.
