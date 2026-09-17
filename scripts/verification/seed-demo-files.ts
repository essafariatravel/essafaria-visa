import { loadEnv } from "@/lib/load-env";
import { env } from "@/lib/env";

/**
 * Demo *content* for a fresh environment — the seed only loads configuration, which
 * leaves every list page empty and makes a staging/UAT box look broken rather than new.
 *
 *   npm run db:migrate && npm run db:seed && npm run db:demo
 *
 * Five files for the seeded demo agency, spread across the lifecycle so the dashboards,
 * queues, checklist engine, document review, wallet and invoices all have something real
 * to show. Everything goes through the application's own services — the same code paths a
 * user drives — so if a phase is broken this script fails instead of inserting a lie.
 *
 * Idempotent by design: it does nothing when applications already exist. Re-run it with
 * FORCE_DEMO=1 to add another set (never edits or deletes what is already there).
 *
 * PGlite note: stop the web process first. The embedded database has one writer, and the
 * app holding it is exactly the case src/lib/pglite-writer-lock.ts refuses.
 */
type Plan = {
  label: string;
  status: string;
  applicants: number;
  reviewed?: "ACCEPT";
  charge?: boolean;
  note?: string;
};

const PLANS: Plan[] = [
  { label: "new enquiry", status: "NEW", applicants: 1 },
  { label: "documents in", status: "DOCUMENTS_RECEIVED", applicants: 2, note: "Passport copies clear; awaiting bank statements." },
  { label: "on the desk", status: "UNDER_REVIEW", applicants: 2, reviewed: "ACCEPT" },
  { label: "billed + lodged", status: "SUBMITTED", applicants: 1, charge: true },
  { label: "granted", status: "APPROVED", applicants: 2 },
];

/*
 * Fixtures the sniffers accept: a PDF needs >1 KB of real header structure, an image
 * needs its magic bytes. Each blob is unique because an upload whose sha256 equals the
 * current version for the same requirement is (correctly) refused as a duplicate.
 */
let seq = 0;
const pdfBytes = () =>
  Buffer.concat([
    Buffer.from("%PDF-1.4\n", "latin1"),
    Buffer.from(`1 0 obj<</T/Catalog /Demo ${++seq}>>endobj\n`.repeat(60), "latin1"),
    Buffer.from("\n%%EOF\n", "latin1"),
  ]);
const pngBytes = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`demo-id-photo-${seq}-`.padEnd(48, "0"), "latin1"),
    Buffer.from("IEND", "ascii"),
    Buffer.from([0xae, 0x42, 0x60, 0x82]),
  ]);
const jpegBytes = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`demo-id-photo-${seq}-`.padEnd(48, "0"), "latin1"),
    Buffer.from([0xff, 0xd9]),
  ]);
/** bytes + extension for a requirement, honouring what that document type accepts */
function fixtureFor(allowed: string[]): { bytes: Buffer; ext: string } {
  const list = allowed.length ? allowed : ["pdf"];
  if (list.includes("pdf")) return { bytes: pdfBytes(), ext: "pdf" };
  if (list.includes("jpg") || list.includes("jpeg")) return { bytes: jpegBytes(), ext: "jpg" };
  return { bytes: pngBytes(), ext: "png" };
}

async function main(): Promise<void> {
  loadEnv();
  const config = env();
  console.log(`\nESSAFARIA VISA OS — demo content (${config.dbMode})\n`);

  const { getDb } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const t = (await getDb()) as unknown as {
    execute: (q: unknown) => Promise<{ rows: Array<Record<string, any>> }>;
  };

  const have = Number((await t.execute(sql`select count(*)::int as n from "visa_applications"`)).rows[0].n);
  if (have > 0 && !process.env.FORCE_DEMO) {
    console.log(`  nothing to do — ${have} application(s) already exist (FORCE_DEMO=1 to add another set)\n`);
    process.exit(0);
    return;
  }

  const owner = (await t.execute(sql`select id, email, name, role from "users" where email = 'owner@saharavoyages.dz' limit 1`)).rows[0];
  const admin = (await t.execute(sql`select id, email, name, role from "users" where email = 'admin@essafaria.local' limit 1`)).rows[0];
  if (!owner || !admin) {
    console.error("  missing the seeded demo accounts — run npm run db:seed first\n");
    process.exit(1);
    return;
  }
  const membership = (await t.execute(sql`select agency_id from "agency_memberships" where user_id = ${owner.id} limit 1`)).rows[0];
  const agencyId = membership?.agency_id as string;

  const { buildActor, buildStaffActor } = await import("@/lib/guard");
  const A = await import("@/lib/applications");
  const AP = await import("@/lib/applicants");
  const D = await import("@/lib/documents");
  const B = await import("@/lib/billing");
  // the billing module owns "which currency does this platform invoice in"
  const currency = await B.defaultCurrencyCode(t as never);

  // the agency actor is built per permission the way the UI does it
  const agencyActor = buildActor(
    { id: owner.id, email: owner.email, name: owner.name, role: "AGENCY_ADMIN", agencyIds: [agencyId] } as never,
    "applications.write",
  );
  const staffActor = buildStaffActor(
    { id: admin.id, email: admin.email, name: admin.name, role: "SUPER_ADMIN", agencyIds: [] } as never,
    "applications.review",
    { agencyId },
  );

  const visaTypes = (await t.execute(sql`select code from "visa_types" where is_active = true order by code limit 3`)).rows as Array<{ code: string }>;
  if (!visaTypes.length) {
    console.error("  no active visa types — the catalogue was not seeded\n");
    process.exit(1);
    return;
  }

  // the ledger and the wallet need a balance before a charge, and funding is a staff
  // action by design (there is no online payment capture in this platform)
  if (PLANS.some((p) => p.charge)) {
    await B.creditWallet(staffActor, {
      agencyId,
      amountCents: 500_000,
      currencyCode: currency,
      reason: "demo float for the UAT walkthrough",
      idempotencyKey: `demo-float-${Date.now()}`,
    });
  }

  let passportSerial = 900000;
  let lastReason = "";
  const made: string[] = [];
  for (const [i, plan] of PLANS.entries()) {
    const visa = visaTypes[i % visaTypes.length].code;
    const file = await A.createApplication(agencyActor, { visaTypeCode: visa, requestedCount: plan.applicants, notes: plan.note ?? null });
    const walk: string[] = [];
    const uploaded: Array<{ documentId: string; code: string }> = [];

    for (let n = 0; n < plan.applicants; n++) {
      passportSerial += 1;
      await AP.upsertApplicant(agencyActor, file.id, {
        fullName: `Traveller ${String(i + 1)}-${n + 1}`,
        dateOfBirth: `19${85 + n}-0${(n % 9) + 1}-1${n % 9}`,
        passportNumber: `DZ${passportSerial}`,
        passportExpiryDate: "2032-06-30",
        nationalityCountryCode: "DZ",
      });
    }

    /*
     * Satisfy the file's own frozen requirement snapshot instead of forcing a
     * transition: the checklist engine decides what this application needs (per
     * applicant, per document type), so uploading exactly the missing items is both
     * the honest demo and a live exercise of Phase 5.
     */
    const tried = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      const bundle = await A.getChecklist(agencyActor, file.id);
      const missing = bundle.items.filter((it) => it.isRequired && !it.satisfiedByCurrentDocument);
      if (!missing.length) break;
      for (const item of missing) {
        const slot = `${item.documentTypeCode}:${item.applicantId ?? "-"}`;
        if (tried.has(slot)) continue; // one attempt per requirement per file
        tried.add(slot);
        const fixture = fixtureFor(item.allowedExtensions ?? []);
        try {
          const up = await D.uploadDocument(agencyActor, file.id, {
            bytes: fixture.bytes,
            filename: `${item.documentTypeCode.toLowerCase()}-${i + 1}.${fixture.ext}`,
            documentTypeCode: item.documentTypeCode,
            applicantId: item.applicantId ?? undefined,
          });
          uploaded.push({ documentId: up.documentId, code: item.documentTypeCode });
        } catch (e) {
          console.log(`        (upload skipped for ${item.documentTypeCode}: ${(e as Error).message.slice(0, 70)})`);
        }
      }
    }

    // a desk that has reviewed nothing looks broken too: accept the pending ones when
    // the plan is meant to sit past document review
    if (plan.reviewed || ["SUBMITTED", "APPROVED"].includes(plan.status)) {
      const pending = (await t.execute(
        sql`select id from "application_documents" where application_id = ${file.id} and is_current = true and review_state = 'PENDING'`,
      )).rows as Array<{ id: string }>;
      for (const row of pending) {
        try {
          await D.reviewDocument(staffActor, row.id, {
            decision: "ACCEPT",
            note: "Clear scan; matches the passport data on file.",
          });
          walk.push(`document ${row.id.slice(0, 8)} accepted`);
        } catch (e) {
          console.log(`        (review skipped: ${(e as Error).message.slice(0, 70)})`);
        }
      }
    }

    /*
     * Walk the configured status graph rather than writing the column: each hop is
     * validated against the live status configuration, so the demo also proves the
     * guards still hold. Agency moves its own file forward where it may; the desk
     * (staff) moves the rest. A refused hop is reported, never forced.
     */
    const chain = ["DOCUMENTS_REQUIRED", "DOCUMENTS_RECEIVED", "UNDER_REVIEW", "READY_FOR_SUBMISSION", "SUBMITTED", "PROCESSING", "APPROVED"];
    const upto = chain.indexOf(plan.status);
    for (const [idx, step] of chain.entries()) {
      if (upto < 0 || idx > upto) break;
      const actors = idx >= 2 ? [staffActor, agencyActor] : [agencyActor, staffActor];
      let moved = false;
      for (const who of actors) {
        try {
          await A.transitionStatus(who, file.id, { toStatusCode: step, reason: "demo walkthrough" });
          walk.push(step);
          moved = true;
          break;
        } catch (e) {
          const err = e as Error;
          if (who === actors[0]) lastReason = `${step}: ${err.message.slice(0, 70)}`;
        }
      }
      if (!moved && lastReason) console.log(`        (${lastReason})`);
    }

    if (plan.note) {
      await A.appendNote(agencyActor, file.id, { body: plan.note, customerVisible: true });
      walk.push("note");
    }
    if (plan.charge) {
      await B.ensureInvoiceForApplication(file.id, undefined, { actor: staffActor });
      await B.chargeApplication(staffActor, file.id);
      walk.push("invoiced + charged");
    }

    if (uploaded.length) walk.push(`${uploaded.length} document(s) uploaded`);
    const now = (await t.execute(sql`select st.code from "visa_applications" va join "application_statuses" st on st.id = va.status_id where va.id = ${file.id}`)).rows[0]?.code;
    made.push(`  ${file.reference}  ${String(now).padEnd(20)} ${plan.applicants} applicant(s)  ${plan.label}`);
    void walk;
  }

  // the demo's own events queued real email intents; deliver them so the outbox is
  // shown working rather than left as an artifact of seeding
  const N = await import("@/lib/notifications");
  const drained = await N.dispatchDueEmails(200);

  console.log(made.join("\n"));
  const counts = (await t.execute(
    sql`select
      (select count(*) from visa_applications)::int as files,
      (select count(*) from applicants)::int as applicants,
      (select count(*) from application_documents)::int as documents,
      (select count(*) from invoices)::int as invoices,
      (select count(*) from notification_deliveries where state = 'QUEUED')::int as queued`,
  )).rows[0];
  console.log(
    `\n  now visible: ${counts.files} files · ${counts.applicants} travellers · ${counts.documents} documents · ` +
      `${counts.invoices} invoices · ${counts.queued} intent(s) left in the queue ` +
      `(${drained.sent} delivered, ${drained.failed} failed — file transport, see MEDIA_ROOT/outbox)\n` +
      `  sign in as owner@saharavoyages.dz (agency) or admin@essafaria.local (staff);\n` +
      `  passwords are SEED_AGENCY_PASSWORD / SEED_ADMIN_PASSWORD in .env\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[demo] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
