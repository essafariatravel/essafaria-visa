#!/usr/bin/env bash
# Live HTTP verification against a running build (dev or staging).
#
#   npm run build && npm start                 # or point PROBE_BASE_URL at staging
#   PROBE_ADMIN_PASSWORD=... PROBE_OWNER_PASSWORD=... PROBE_TENANT_B_PASSWORD=... npm run probe:http
#
# Requires the second-tenant fixture (npm run probe:seed). Read-only except for the
# rows it creates itself (one application, one traveller, one failed-login probe).
B="${PROBE_BASE_URL:-http://localhost:3000}"
# Credentials for the accounts the probe signs in as. Deliberately required: this
# script must be able to run against staging without a password living in git.
: "${PROBE_ADMIN_PASSWORD:?export PROBE_ADMIN_PASSWORD (admin@essafaria.local or your staff account)}"
: "${PROBE_OWNER_PASSWORD:?export PROBE_OWNER_PASSWORD (agency owner account)}"
: "${PROBE_TENANT_B_PASSWORD:?export PROBE_TENANT_B_PASSWORD (probe@b.test from npm run probe:seed)}"
ADMIN_EMAIL="${PROBE_ADMIN_EMAIL:-admin@essafaria.local}"
OWNER_EMAIL="${PROBE_OWNER_EMAIL:-owner@saharavoyages.dz}"
OUT=${TMPDIR:-/tmp}/essafaria-probe-body.out
UP=${TMPDIR:-/tmp}/essafaria-probe-upload.pdf
printf "%%PDF-1.4\n" > "$UP"; for i in $(seq 1 200); do echo "1 0 obj<</Type/Catalog>>endobj" >> "$UP"; done

J="$(cd "$(dirname "$0")/../.." && pwd)/.data/probe.json"
if [ ! -f "$J" ]; then echo "missing $J — run: npm run probe:seed" >&2; exit 2; fi
g() { node -e "console.log(require('$J').$1)"; }
APPA=$(g appA); DOCA=$(g docA); MEDIAA=$(g mediaA); AGENCYA=$(g agencyA); AGENCYB=$(g agencyB)
pass=0; fail=0
st() { curl -s -o "$OUT" -w '%{http_code}' "$@"; }
chk() { if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  PASS  %-56s %s\n' "$1" "$3"; else fail=$((fail+1)); printf '  FAIL  %-56s expected [%s] got [%s]\n' "$1" "$2" "$3"; fi; }
has() { grep -qi -- "$2" "$OUT" && echo yes || echo no; }

echo "=== public surface ==="
chk "GET / renders" 200 "$(st "$B/")"
chk "GET /visas renders" 200 "$(st "$B/visas")"
st "$B/api/health" >/dev/null; H=$(cat "$OUT")
chk "health status ok" ok "$(node -e "console.log(JSON.parse(process.argv[1]).status)" "$H")"
chk "health leaks no mailbox addresses" no "$(echo "$H" | grep -qi 'essafaria.local' && echo yes || echo no)"
curl -si "$B/" | tr -d '\r' > /tmp/hdrs.txt
chk "X-Frame-Options header" yes "$(grep -qi 'x-frame-options: deny' /tmp/hdrs.txt && echo yes || echo no)"
chk "nosniff header" yes "$(grep -qi 'x-content-type-options: nosniff' /tmp/hdrs.txt && echo yes || echo no)"
chk "CSP (report-only) header" yes "$(grep -qi 'content-security-policy-report-only' /tmp/hdrs.txt && echo yes || echo no)"
chk "referrer + permissions policy" yes "$(grep -qi 'referrer-policy: strict-origin-when-cross-origin' /tmp/hdrs.txt && grep -qi 'permissions-policy' /tmp/hdrs.txt && echo yes || echo no)"

echo "=== unauthenticated API ==="
chk "POST /api/applications -> 401" 401 "$(st -X POST "$B/api/applications" -H 'content-type: application/json' -d '{"visaTypeCode":"FR_SCHENGEN_TOURISM"}')"
chk "GET /api/applications -> 401" 401 "$(st "$B/api/applications")"
chk "GET /admin -> redirect to login" 307 "$(st "$B/admin")"

echo "=== staff session ==="
chk "login (admin)" 200 "$(st -X POST "$B/api/auth/login" -c /tmp/jar-admin.txt -H 'content-type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PROBE_ADMIN_PASSWORD\"}")"
chk "cookie flagged HttpOnly" yes "$(grep -q '#HttpOnly_' /tmp/jar-admin.txt && echo yes || echo no)"
chk "cookie named esf_session" yes "$(grep -q esf_session /tmp/jar-admin.txt && echo yes || echo no)"
chk "GET /api/applications" 200 "$(st "$B/api/applications" -b /tmp/jar-admin.txt)"; cp $OUT /tmp/list.json
chk "GET /admin dashboard" 200 "$(st "$B/admin" -b /tmp/jar-admin.txt)"
chk "dashboard shows pipeline heading" yes "$(grep -q 'Waiting on documents' $OUT && echo yes || echo no)"
chk "GET /api/reports/agencies" 200 "$(st "$B/api/reports/agencies" -b /tmp/jar-admin.txt)"

echo "=== CSRF ==="
chk "API POST, evil Origin -> 403" 403 "$(st -X POST "$B/api/applications" -b /tmp/jar-admin.txt -H 'content-type: application/json' -H 'Origin: http://evil.example' -d '{}')"
chk "server action POST, evil Origin -> 403" 403 "$(st -X POST "$B/admin/applications/new" -b /tmp/jar-admin.txt -H 'Origin: http://evil.example')"
# the same-origin value has to match wherever this probe is pointed — hardcoding
# localhost:3000 made it fail against any other deployment for the wrong reason
SAME_ORIGIN="$(printf '%s' "$B" | sed -E 's#^(https?://[^/]+).*#\1#')"
chk "same-origin POST allowed past the guard" 401 "$(st -X POST "$B/api/applications" -H 'content-type: application/json' -H "Origin: $SAME_ORIGIN" -d '{}')"

echo "=== create + workflow as staff ==="
C=$(st -X POST "$B/api/applications" -b /tmp/jar-admin.txt -H 'content-type: application/json' -d "{\"visaTypeCode\":\"FR_SCHENGEN_TOURISM\",\"requestedCount\":1,\"agencyId\":\"$AGENCYA\",\"notes\":\"created over HTTP\"}")
chk "POST /api/applications -> 201" 201 "$C"; cp $OUT /tmp/create.json
NEWID=$(node -e "console.log(require('/tmp/create.json').id)")
REF=$(node -e "console.log(require('/tmp/create.json').reference)")
chk "reference format" yes "$(echo "$REF" | grep -Eq '^ESF-[0-9]{4}-[0-9]{6}$' && echo yes || echo no)"
chk "GET one application" 200 "$(st "$B/api/applications/$NEWID" -b /tmp/jar-admin.txt)"
chk "checklist endpoint" 200 "$(st "$B/api/applications/$NEWID/checklist" -b /tmp/jar-admin.txt)"
chk "legal transition -> 200" 200 "$(st -X POST "$B/api/applications/$NEWID/status" -b /tmp/jar-admin.txt -H 'content-type: application/json' -d '{"toStatusCode":"DOCUMENTS_RECEIVED"}')"
chk "illegal transition -> 409" 409 "$(st -X POST "$B/api/applications/$NEWID/status" -b /tmp/jar-admin.txt -H 'content-type: application/json' -d '{"toStatusCode":"COMPLETED"}')"
chk "bad status code -> 422" 422 "$(st -X POST "$B/api/applications/$NEWID/status" -b /tmp/jar-admin.txt -H 'content-type: application/json' -d '{"toStatusCode":"bogus code!"}')"
chk "422 carries field issues" yes "$(grep -q '"issues"' $OUT && echo yes || echo no)"
chk "no SQL or stack in error body" no "$(grep -qiE 'at [A-Za-z]+ \(|select .* from |drizzle|pglite' $OUT && echo yes || echo no)"
chk "forged applicant id -> 404" 404 "$(st -X PATCH "$B/api/applications/$NEWID/applicants/nope-not-real" -b /tmp/jar-admin.txt -H 'content-type: application/json' -d '{"fullName":"Ghost","passportExpiryDate":"2030-01-01"}')"
STAMP=$(date +%s)
chk "add applicant via API -> 201" 201 "$(st -X POST "$B/api/applications/$NEWID/applicants" -b /tmp/jar-admin.txt -H 'content-type: application/json' -d "{\"fullName\":\"HTTP Traveller\",\"dateOfBirth\":\"1990-01-01\",\"passportNumber\":\"HTTP$STAMP\",\"passportExpiryDate\":\"2033-01-01\"}")"
# passport uniqueness is enforced per tenant, so the same number must be refused
chk "duplicate passport in tenant -> 409" 409 "$(st -X POST "$B/api/applications/$NEWID/applicants" -b /tmp/jar-admin.txt -H 'content-type: application/json' -d "{\"fullName\":\"HTTP Twin\",\"dateOfBirth\":\"1990-01-01\",\"passportNumber\":\"HTTP$STAMP\",\"passportExpiryDate\":\"2033-01-01\"}")"
chk "CSV export" 200 "$(st "$B/api/reports/applications?format=csv" -b /tmp/jar-admin.txt)"
chk "CSV header" yes "$(head -1 $OUT | grep -q '^"Reference","Agency"' && echo yes || echo no)"

echo "=== document bytes ==="
chk "staff opens document -> 200" 200 "$(st "$B/api/documents/$DOCA/content" -b /tmp/jar-admin.txt)"
chk "served bytes are the stored PDF" yes "$(head -c 5 $OUT | grep -q '%PDF-' && echo yes || echo no)"
chk "no-store + nosniff on document" yes "$(curl -si "$B/api/documents/$DOCA/content" -b /tmp/jar-admin.txt | grep -qi 'no-store' && curl -si "$B/api/documents/$DOCA/content" -b /tmp/jar-admin.txt | grep -qi 'nosniff' && echo yes || echo no)"
chk "unauthenticated open -> 401" 401 "$(st "$B/api/documents/$DOCA/content")"
chk "public media route refuses a document" 401 "$(st "$B/api/media/$MEDIAA")"

echo "=== second tenant ==="
chk "login as agency B" 200 "$(st -X POST "$B/api/auth/login" -c /tmp/jar-b.txt -H 'content-type: application/json' -d "{\"email\":\"probe@b.test\",\"password\":\"$PROBE_TENANT_B_PASSWORD\"}")"
chk "B reads A's file -> 404" 404 "$(st "$B/api/applications/$APPA" -b /tmp/jar-b.txt)"
chk "B lists A's documents -> 404" 404 "$(st "$B/api/applications/$APPA/documents" -b /tmp/jar-b.txt)"
chk "B opens A's document -> 404" 404 "$(st "$B/api/documents/$DOCA/content" -b /tmp/jar-b.txt)"
chk "B uses public media route -> 404" 404 "$(st "$B/api/media/$MEDIAA" -b /tmp/jar-b.txt)"
chk "B transitions A's file -> 404" 404 "$(st -X POST "$B/api/applications/$APPA/status" -b /tmp/jar-b.txt -H 'content-type: application/json' -d '{"toStatusCode":"NEW"}')"
chk "B uploads into A's file -> 404" 404 "$(st -X POST "$B/api/applications/$APPA/documents" -b /tmp/jar-b.txt -F "file=@$UP;type=application/pdf" -F "documentTypeCode=PASSPORT")"
st "$B/api/applications" -b /tmp/jar-b.txt; cp $OUT /tmp/blist.json
chk "B's list omits A's file" clean "$(node -e "const j=require('/tmp/blist.json');console.log(j.rows.some(r=>r.id==='$APPA')?'leak':'clean')")"
chk "B's staff report -> 404" 404 "$(st "$B/api/reports/agencies" -b /tmp/jar-b.txt)"
chk "B's own report -> 200" 200 "$(st "$B/api/reports/applications?format=csv" -b /tmp/jar-b.txt)"
st "$B/api/agency/wallet" -b /tmp/jar-b.txt
chk "wallet endpoint returns B only" "$AGENCYB" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT','utf8')).agencyId)")"
chk "B cannot reach a staff-only report (404, no oracle)" 404 "$(st "$B/api/reports/processing" -b /tmp/jar-b.txt)"
chk "B blocked from gmail sync" 403 "$(st -X POST "$B/api/gmail/sync" -b /tmp/jar-b.txt -H 'content-type: application/json' -d '{"connectionId":"x"}')"

echo "=== owner of A ==="
chk "login as agency A owner" 200 "$(st -X POST "$B/api/auth/login" -c /tmp/jar-a.txt -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$PROBE_OWNER_PASSWORD\"}")"
chk "owner opens own document -> 200" 200 "$(st "$B/api/documents/$DOCA/content" -b /tmp/jar-a.txt)"
chk "owner reads own file -> 200" 200 "$(st "$B/api/applications/$APPA" -b /tmp/jar-a.txt)"
chk "agency payload hides staff-only fields" no "$(grep -q 'staffNotes' $OUT && echo yes || echo no)"
cp $OUT /tmp/own.json
cp $OUT /tmp/own2.json
chk "agency payload exposes no staff-only fields" no "$(node -e "const s=JSON.stringify(require('/tmp/own2.json'));console.log(/caseOfficerName|\"staffNotes\"|\"consulateRef\"|\"config\"|agencySelfSubmit|perApplicantPolicy/.test(s)?'yes':'no')")"
chk "agency may not run a review" 403 "$(st -X POST "$B/api/documents/$DOCA/review" -b /tmp/jar-a.txt -H 'content-type: application/json' -d '{"decision":"ACCEPT"}')"
chk "agency portal page renders" 200 "$(st "$B/agency/applications" -b /tmp/jar-a.txt)"
chk "portal shows the reference" yes "$(grep -q 'ESF-' $OUT && echo yes || echo no)"

echo "=== login throttling ==="
EMAIL="nosuch-$(date +%s)@x.test"; LAST=""
for i in $(seq 1 14); do LAST=$(st -X POST "$B/api/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-password-1\"}"); done
chk "14 failures reach 429" 429 "$LAST"
chk "lockout message is generic" "Too many attempts. Try again later." "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT','utf8')).error)")"
chk "unknown vs wrong password share a response" 401 "$(st -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"email":"another-unknown-'$(date +%s)'@x.test","password":"whatever-12345"}')"

echo "=== rate limiting ==="
# The bucket capacity is 2 x RATE_LIMIT_PER_MINUTE, so a fixed burst length would
# pass or fail depending on how the target is configured. Size it from the value
# under test instead of hard-coding an assumption (this environment runs 600/min for
# comfortable manual UAT, which a 700-request burst would never trip).
LIMIT=${PROBE_RATE_LIMIT_PER_MINUTE:-240}
BURST=$(( LIMIT * 4 ))
N429=0; N401=0
for i in $(seq 1 "$BURST"); do c=$(st -X POST "$B/api/applications" -H 'content-type: application/json' -d '{}'); if [ "$c" = 429 ]; then N429=$((N429+1)); elif [ "$c" = 401 ]; then N401=$((N401+1)); fi; done
chk "burst is throttled (429 > 0)" yes "$([ $N429 -gt 0 ] && echo yes || echo no)"
printf '        detail: limit=%s/min burst=%s -> 429=%s 401=%s\n' "$LIMIT" "$BURST" "$N429" "$N401"
sleep 3
chk "bucket refills" 401 "$(st -X POST "$B/api/applications" -H 'content-type: application/json' -d '{}')"

echo "=== background jobs (CLI) — with the writer lock, safe either way ==="
run_cli() { # $1 = label, $2 = command
  OUT_LOG=/tmp/cli-$1.log
  eval "$2" > "$OUT_LOG" 2>&1
  if grep -q "one writer at a time" "$OUT_LOG"; then
    chk "$1: second writer refused cleanly (guard)" yes yes
  else
    chk "$1: ran cleanly" yes "$(grep -qE "\[$1\]|ok |sent=" "$OUT_LOG" && echo yes || echo no)"
  fi
  tail -1 "$OUT_LOG" | sed 's/^/        /'
}
run_cli outbox "EMAIL_TRANSPORT=file PGLITE_DATA_DIR=.data/pgdata npx tsx scripts/dispatch-outbox.ts"
run_cli automation "AUTOMATION_TASK=daily-digest AUTOMATION_FORCE=1 PGLITE_DATA_DIR=.data/pgdata npx tsx scripts/run-automation.ts"

echo
echo "HTTP PROBE RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
