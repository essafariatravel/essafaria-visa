import { loadEnv } from "@/lib/load-env";
import { env } from "@/lib/env";

/**
 * Real concurrency check — run it against a PostgreSQL *server*.
 *
 *   DATABASE_MODE=postgres DATABASE_URL=postgresql://... npm run verify:concurrency
 *
 * The test suite proves the logic; this proves the same logic survives actual
 * contention, which a single in-process database cannot show. Four races, each of
 * which would be a data-integrity incident if it were wrong:
 *
 *   1. reference numbers — parallel file creation must never collide or skip
 *   2. wallet charging   — N concurrent submissions of one file charge exactly once
 *   3. outbox dispatch   — M dispatchers on one queue must send each message once
 *   4. document versions — parallel uploads leave exactly one current row
 *
 * It creates its own throwaway tenants and cleans them up. It refuses to run unless
 * the target is a real Postgres server, so it can never silently "pass" on the
 * embedded driver and mislead someone about what was measured.
 *
 * Exit 0 = every invariant held. Exit 1 = something broke (or it could not run).
 */
type Verdict = { name: string; ok: boolean; detail: string };
const results: Verdict[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${detail}`);
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  loadEnv();
  const config = env();
  console.log("\nESSAFARIA VISA OS — concurrency check (real PostgreSQL contention)\n");
  if (config.dbMode !== "postgres" || !config.DATABASE_URL) {
    console.error(
      "REFUSED: this check needs DATABASE_URL pointing at a real PostgreSQL server.\n" +
        "       The embedded driver uses one in-process connection, so a 'pass' there\n" +
        "       would say nothing about locking. Run with:\n" +
        "         DATABASE_MODE=postgres DATABASE_URL=postgresql://… npm run verify:concurrency\n",
    );
    process.exit(1);
    return;
  }

  const { getDb, schema } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { hashPassword } = await import("@/lib/password");
  const { buildActor, buildStaffActor } = await import("@/lib/guard");
  const A = await import("@/lib/applications");
  const AP = await import("@/lib/applicants");
  const D = await import("@/lib/documents");
  const B = await import("@/lib/billing");
  const N = await import("@/lib/notifications");

  const t = (await getDb()) as unknown as {
    select: (...a: unknown[]) => any;
    insert: (t: unknown) => { values: (v: unknown) => { returning: () => Promise<any[]> } };
    execute: (q: unknown) => Promise<{ rows: Array<Record<string, any>> }>;
  };
  const { agencies, users, agencyMemberships, visaTypes } = schema;

  const pw = await hashPassword("concurrency-check-1");
  const tag = Date.now().toString(36).toUpperCase();
  const agencyIds: string[] = [];
  const [visaType] = await t
    .select({ id: visaTypes.id, code: visaTypes.code })
    .from(visaTypes)
    .where(sql`is_active = true`)
    .limit(1);
  if (!visaType) {
    console.error("no active visa type — run npm run db:seed first");
    process.exit(1);
    return;
  }
  // a real users row: audit writes reference it, and that is exactly the kind of
  // integrity the check must not paper over with a synthetic actor id
  const [staffUser] = await t
    .insert(users)
    .values({ email: `cc-staff-${tag}@check.local`, name: `CC staff ${tag}`, passwordHash: pw, role: "SUPER_ADMIN" })
    .returning();
  const staff = buildStaffActor(
    { id: staffUser.id, email: staffUser.email, name: staffUser.name, role: "SUPER_ADMIN", agencyIds: [] } as never,
    "wallet.write",
  );

  async function makeAgency(role: "CCR" | "CCW" | "CCO" | "CCD") {
    const code = `${role}${tag}`;
    const [agency] = await t.insert(agencies).values({ code, name: `Concurrency ${code}`, status: "ACTIVE" }).returning();
    const [user] = await t
      .insert(users)
      .values({ email: `cc-${code.toLowerCase()}@check.local`, name: code, passwordHash: pw, role: "AGENCY_ADMIN" })
      .returning();
    await t.insert(agencyMemberships).values({ agencyId: agency.id, userId: user.id, isPrimary: true });
    agencyIds.push(agency.id);
    const actor = buildActor(
      { id: user.id, email: user.email, name: code, role: "AGENCY_ADMIN", agencyIds: [agency.id] } as never,
      "applications.write",
    );
    return { agency, actor };
  }

  /* ---------------- 1. reference numbers ---------------- */
  {
    const { actor } = await makeAgency("CCR");
    const files = await Promise.all(
      Array.from({ length: 24 }, () => A.createApplication(actor, { visaTypeCode: visaType.code, requestedCount: 1 })),
    );
    const refs = files.map((f: { reference: string }) => f.reference);
    const nums = refs.map((r: string) => Number(r.split("-").pop())).sort((x: number, y: number) => x - y);
    check("reference numbers unique", new Set(refs).size === refs.length, `${new Set(refs).size}/${refs.length} distinct under 24-way contention`);
    check(
      "reference sequence has no gaps",
      nums.every((n: number, i: number) => i === 0 || n === nums[i - 1] + 1),
      `${nums[0]} … ${nums[nums.length - 1]}`,
    );
  }

  /* ---------------- 2. exactly-once charging ---------------- */
  {
    const { agency, actor } = await makeAgency("CCW");
    const created = await A.createApplication(actor, { visaTypeCode: visaType.code, requestedCount: 1 });
    await AP.upsertApplicant(actor, created.id, { fullName: "One Charge", dateOfBirth: "1990-01-01", passportExpiryDate: "2032-01-01" });
    const invoice = await B.ensureInvoiceForApplication(created.id, undefined, { actor: staff });
    await B.creditWallet(staff, {
      agencyId: agency.id,
      amountCents: invoice.subtotalCents * 5,
      currencyCode: "EUR",
      reason: "concurrency float",
      idempotencyKey: `cc-float-${tag}`,
    });
    const before = Number(
      (await t.execute(sql`select wallet_balance_cents as b from "agencies" where id = ${agency.id}`)).rows[0].b,
    );

    const raced = await Promise.allSettled(Array.from({ length: 20 }, () => B.chargeApplication(staff, created.id)));
    const succeeded = raced.filter((r) => r.status === "fulfilled").length;

    const ledger = await t.execute(
      sql`select count(*)::int as n, coalesce(sum(amount_cents),0)::bigint as total
             from "agency_wallet_transactions" where application_id = ${created.id} and kind = 'DEBIT'`,
    );
    const after = Number((await t.execute(sql`select wallet_balance_cents as b from "agencies" where id = ${agency.id}`)).rows[0].b);
    // 20 racing callers, but the wallet may move once: one debit row, every due item
    // charged exactly once and all pointing at that same ledger row.
    const items = await t.execute(
      sql`select count(*)::int as total,
                  count(*) filter (where charge_status = 'CHARGED')::int as charged,
                  count(distinct wallet_tx_id)::int as distinct_tx,
                  coalesce(sum(amount_cents) filter (where charge_status = 'CHARGED'),0)::bigint as charged_cents
             from "invoice_items" where invoice_id = ${invoice.invoiceId}`,
    );
    const it = items.rows[0];
    check(
      "exactly one charge recorded",
      Number(ledger.rows[0].n) === 1 &&
        Number(it.charged) === Number(it.total) &&
        Number(it.distinct_tx) === 1 &&
        succeeded === raced.length,
      `${ledger.rows[0].n} debit row(s), ${it.charged}/${it.total} items charged via ${it.distinct_tx} ledger row(s), ` +
        `${succeeded}/${raced.length} callers returned success (idempotent no-ops)`,
    );
    check(
      "balance moved exactly once",
      after === before + Number(ledger.rows[0].total) && Math.abs(Number(it.charged_cents)) === Math.abs(Number(ledger.rows[0].total)),
      `${before} → ${after}; items ${it.charged_cents}, ledger ${ledger.rows[0].total}`,
    );
    check("no negative balance", after >= 0, `balance ${after}`);
  }

  /* ---------------- 3. outbox dispatch ---------------- */
  {
    const { agency, actor } = await makeAgency("CCO");
    const created = await A.createApplication(actor, { visaTypeCode: visaType.code, requestedCount: 1 });
    for (let i = 0; i < 12; i++) {
      await N.notify({
        agencyId: agency.id,
        applicationId: created.id,
        kind: "concurrency.race",
        title: `race ${i}`,
        body: `concurrency probe ${i}`,
        dedupeKey: `cc-race-${tag}-${i}`,
        email: { subject: `race ${i}`, body: "probe" },
      });
    }
    const queuedBefore = Number(
      (await t.execute(
        sql`select count(*)::int as n from "notification_deliveries"
             where state = 'QUEUED' and notification_id in (select id from notifications where agency_id = ${agency.id})`,
      ))
        .rows[0].n,
    );

    // a slow send widens the race window: without an atomic claim, every dispatcher
    // below would pick the same rows up while the first one is still "in flight"
    const sends: string[] = [];
    const dispatch = () =>
      N.drainOutbox({
        limit: 50,
        send: async (d: { id: string }) => {
          sends.push(d.id);
          await settle(40);
          return { ok: true, providerMessageId: `cc-${sends.length}` };
        },
        now: new Date(Date.now() + 60_000), // ignore backoff windows between passes
      });
    const six = await Promise.all(Array.from({ length: 6 }, dispatch));
    const dupes = sends.length - new Set(sends).size;
    const sentCount = Number(
      (await t.execute(
        sql`select count(*)::int as n from "notification_deliveries"
             where state = 'SENT' and notification_id in (select id from notifications where agency_id = ${agency.id})`,
      ))
        .rows[0].n,
    );
    check("no message sent twice", dupes === 0, `${sends.length} send calls for ${queuedBefore} queued intents across 6 dispatchers`);
    check(
      "every queued intent delivered",
      sentCount === queuedBefore && six.reduce((n, r) => n + r.failed, 0) === 0,
      `${sentCount}/${queuedBefore} SENT, ${six.reduce((n, r) => n + r.failed, 0)} failed`,
    );
  }

  /* ---------------- 4. document versions ---------------- */
  {
    const { actor } = await makeAgency("CCD");
    const created = await A.createApplication(actor, { visaTypeCode: visaType.code, requestedCount: 1 });
    const applicant = await AP.upsertApplicant(actor, created.id, {
      fullName: "Version Race",
      dateOfBirth: "1990-01-01",
      passportExpiryDate: "2032-01-01",
    });
    const bytes = (n: number) =>
      Buffer.concat([
        Buffer.from("%PDF-1.4\n", "latin1"),
        Buffer.from("1 0 obj<</Type/Catalog>>endobj\n".repeat(70 + n), "latin1"),
        Buffer.from("\n%%EOF\n", "latin1"),
      ]);
    const raced = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        D.uploadDocument(actor, created.id, { bytes: bytes(i), filename: `v${i}.pdf`, documentTypeCode: "PASSPORT", applicantId: applicant.id }),
      ),
    );
    const accepted = raced.filter((r) => r.status === "fulfilled").length;
    const currents = Number(
      (
        await t.execute(
          sql`select count(*)::int as n from "application_documents" d
                join document_types dt on dt.id = d.document_type_id
               where d.application_id = ${created.id} and d.is_current = true and dt.code = 'PASSPORT'`,
        )
      ).rows[0].n,
    );
    const distinctVersions = Number(
      (await t.execute(sql`select count(distinct version)::int as n from "application_documents" where application_id = ${created.id}`)).rows[0].n,
    );
    check("exactly one current version", currents === 1, `${currents} current row(s) after ${accepted} concurrent uploads`);
    check("version numbers do not collide", distinctVersions === accepted, `${distinctVersions} distinct versions for ${accepted} uploads`);
  }

  /* ---------------- cleanup (best effort) ----------------
   * Children first: history and money rows are deliberately protected by
   * ON DELETE RESTRICT. Anything this cannot remove is still identifiable by the
   * throwaway tenant prefix (CC…). Run against a scratch or staging database.
   */
  const ids = agencyIds.map((id) => `'${id}'`).join(",");
  const apps = `select id from visa_applications where agency_id in (${ids})`;
  const invs = `select id from invoices where agency_id in (${ids})`;
  const cleanup = [
    // the ledger and the invoice items point at each other, so break that cycle first
    `update "invoice_items" set wallet_tx_id = null where invoice_id in (${invs})`,
    `delete from "agency_wallet_transactions" where agency_id in (${ids})`,
    `delete from "invoice_items" where invoice_id in (${invs})`,
    `delete from "invoices" where agency_id in (${ids})`,
    `delete from "ai_suggestions" where application_id in (${apps})`,
    `delete from "application_documents" where agency_id in (${ids})`,
    `delete from "application_events" where application_id in (${apps})`,
    `delete from "applicants" where agency_id in (${ids})`,
    `delete from "communications" where agency_id in (${ids})`,
    `delete from "notification_deliveries" where notification_id in (select id from notifications where agency_id in (${ids}))`,
    `delete from "notifications" where agency_id in (${ids})`,
    `delete from "audit_logs" where actor_id in (select id from users where email like 'cc-%@check.local')`,
    `delete from "visa_applications" where agency_id in (${ids})`,
    `delete from "application_snapshots" where application_id in (${apps})`,
    `delete from "agency_memberships" where agency_id in (${ids})`,
    `delete from "sessions" where user_id in (select id from users where email like 'cc-%@check.local')`,
    `delete from "users" where email like 'cc-%@check.local'`,
    `delete from "agencies" where id in (${ids})`,
  ];
  let cleaned = 0;
  for (const stmt of cleanup) {
    try {
      await (t as any).execute(sql.raw(stmt));
      cleaned++;
    } catch (e) {
      const table = /delete from "?([a-z_]+)"?/.exec(stmt)?.[1] ?? "?";
      console.log(`  (cleanup: ${table} left in place — ${(e as Error).message.split("\n")[0].slice(0, 70)})`);
    }
  }
  console.log(`\n  (cleanup: ${cleaned}/${cleanup.length} statements applied; leftovers carry the CC… tenant prefix)\n`);

  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} invariants held under real contention\n`);
  if (failed.length) for (const f of failed) console.log(`  ! ${f.name}: ${f.detail}`);
  console.log("");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("[concurrency] crashed:", e instanceof Error ? e.stack?.split("\n").slice(0, 5).join("\n") : e);
  process.exit(1);
});
