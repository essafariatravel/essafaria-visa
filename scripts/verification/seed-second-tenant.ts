import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { loadEnv } from "../../src/lib/load-env";

/**
 * Second-tenant fixture for the live HTTP probe (scripts/verification/http-probe.sh).
 *
 * Creates a partner agency that must never see the seeded partner's data, opens a
 * file for each, and records their ids in .data/probe.json (gitignored). It follows
 * DATABASE_MODE: against a real PostgreSQL server it runs whenever you like — pointing
 * at the same database the deployed app uses is the whole point — while embedded
 * PGlite needs the web process stopped, because one writer at a time.
 *
 *   PROBE_TENANT_B_PASSWORD=... PROBE_OWNER_PASSWORD=... npm run probe:seed
 *
 * Passwords come from the environment on purpose — nothing secret is committed.
 */
const PW_B = process.env.PROBE_TENANT_B_PASSWORD ?? "";
const PW_OWNER = process.env.PROBE_OWNER_PASSWORD ?? "";
if (PW_B.length < 8 || PW_OWNER.length < 8) {
  console.error("[probe-seed] set PROBE_TENANT_B_PASSWORD and PROBE_OWNER_PASSWORD (8+ chars) — the same values the target database was seeded with for the owner account");
  process.exit(1);
}
async function main() {
  loadEnv(); // same env contract as the app and every other script
  const D = await import("../../src/db/index");
  const { env } = await import("../../src/lib/env");
  let db: unknown;
  let close: (() => Promise<void>) | null = null;
  if (env().dbMode === "pglite") {
    // embedded: this fixture has to share the exact cluster the server opened, so the
    // same single-writer rule applies — refuse instead of corrupting a running server
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const dataDir = path.resolve(process.cwd(), ".data/pgdata");
    const { acquireWriterLock } = await import("../../src/lib/pglite-writer-lock");
    acquireWriterLock(dataDir, "npm run probe:seed");
    const client = new PGlite(dataDir);
    db = drizzle(client, { schema: D.schema });
    close = () => client.close();
  } else {
    // a real deployment: connect to the same database the app is serving, which is
    // precisely what makes the probe meaningful against staging
    db = await D.getDb();
  }
  D.__setDbOverride(db as never);
  const t = db as any;
  const { hashPassword } = await import("../../src/lib/password");
  const { agencies, users, agencyMemberships, visaTypes, visaApplications, applicants, applicationDocuments } = D;
  const { buildActor } = await import("../../src/lib/guard");

  const [b] = await t.insert(agencies).values({ code: "HB", name: "Probe Agency B", status: "ACTIVE" }).onConflictDoNothing().returning();
  const [bu] = await t.insert(users).values({ email: "probe@b.test", name: "Probe B", passwordHash: await hashPassword(PW_B), role: "AGENCY_ADMIN" }).onConflictDoNothing().returning();
  const agencyB = b ?? (await t.select().from(agencies).where(sql`code = 'HB'`).limit(1))[0];
  const userB = bu ?? (await t.select().from(users).where(sql`email = 'probe@b.test'`).limit(1))[0];
  // onConflictDoNothing means a re-run keeps the existing row — so re-apply the
  // password from the environment. The probe must always be able to sign in with
  // what the operator just exported, whichever run created the account.
  if (!bu) {
    await t.update(users).set({ passwordHash: await hashPassword(PW_B), isActive: true }).where(sql`${users.id} = ${userB.id}`);
  }
  if (!b) {
    await t.update(agencies).set({ status: "ACTIVE" }).where(sql`${agencies.id} = ${agencyB.id}`);
  }
  await t.insert(agencyMemberships).values({ agencyId: agencyB.id, userId: userB.id, isPrimary: true }).onConflictDoNothing();

  const owner = (await t.select().from(users).where(sql`email = 'owner@saharavoyages.dz'`).limit(1))[0];
  const ownerMembership = (await t.select().from(agencyMemberships).where(sql`user_id = ${owner.id}`).limit(1))[0];
  const vt = (await t.select().from(visaTypes).where(sql`is_active = true`).limit(1))[0];
  const A = await import("../../src/lib/applications");
  const AP = await import("../../src/lib/applicants");
  const DOC = await import("../../src/lib/documents");

  const ownerActor = buildActor({ id: owner.id, email: owner.email, name: "O", role: "AGENCY_ADMIN", agencyIds: [ownerMembership.agencyId] } as never, "applications.write");
  let appA = (await t.select().from(visaApplications).where(sql`notes = 'secret internal note for tenant A'`).limit(1))[0];
  if (!appA) appA = await A.createApplication(ownerActor, { visaTypeCode: vt.code, requestedCount: 1, notes: "secret internal note for tenant A" });
  let applicant = (await t.select().from(applicants).where(sql`passport_number = 'PROBE01'`).limit(1))[0];
  if (!applicant) applicant = await AP.upsertApplicant(ownerActor, appA.id, { fullName: "Tenant A Traveller", passportNumber: "PROBE01", passportExpiryDate: "2033-01-01", dateOfBirth: "1990-01-01", nationalityCountryCode: "DZ" });
  const appAId = appA.id as string;
  const applicantId = applicant.id as string;
  let doc = (await t.select().from(applicationDocuments).where(sql`application_id = ${appAId}`).limit(1))[0];
  if (!doc) {
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "latin1"),
      Buffer.from("1 0 obj<</T/Catalog>>endobj\n".repeat(60), "latin1"),
      Buffer.from("\n%%EOF\n", "latin1"),
    ]);
    doc = await DOC.uploadDocument(ownerActor, appAId, { bytes: pdf, filename: "a-passport.pdf", documentTypeCode: "PASSPORT", applicantId });
  }
  let appB = (await t.select().from(visaApplications).where(sql`agency_id = ${agencyB.id}`).limit(1))[0];
  if (!appB) {
    const bActor = buildActor({ id: userB.id, email: userB.email, name: "P", role: "AGENCY_ADMIN", agencyIds: [agencyB.id] } as never, "applications.write");
    appB = await A.createApplication(bActor, { visaTypeCode: vt.code, requestedCount: 1 });
  }

  mkdirSync(".data", { recursive: true });
  writeFileSync(path.resolve(process.cwd(), ".data/probe.json"), JSON.stringify({
    appA: appAId, refA: appA.reference, applicantA: applicantId,
    docA: (doc as any).documentId ?? doc.id, mediaA: (doc as any).mediaId,
    appB: appB.id, agencyB: agencyB.id, userB: userB.id, ownerA: owner.id, agencyA: ownerMembership.agencyId,
  }, null, 2));
  console.log("probe seeded:", appAId.slice(0, 8), (doc as any).documentId ? "doc created" : "doc reused");
  if (close) await close();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", String(e).slice(0, 400)); process.exit(1); });
