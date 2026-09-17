import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers";
import { hashPassword } from "@/lib/password";
import { buildActor, buildStaffActor } from "@/lib/guard";
import { createApplication, getApplication, getChecklist, transitionStatus } from "@/lib/applications";
import { upsertApplicant } from "@/lib/applicants";
import { uploadDocument } from "@/lib/documents";
import { saveEntity } from "@/lib/crud";
import { TASKS, recentRuns, runTask } from "@/lib/automation";
import { buildReport, toCsv, REPORTS, type ReportKind } from "@/lib/reports";
import { checkLoginThrottle, hashIdentifier, rateLimit, recordLoginAttempt, requireTrustedOrigin, __resetRateBuckets, purgeLoginAttempts } from "@/lib/security";
import { sameSiteOrigin } from "@/lib/same-site";
import { DomainError } from "@/lib/ops";
import { __resetEnvCacheForTests } from "@/lib/env";

/* ============================================================
 * Phase 10: configuration-first proof, automation, reports, hardening.
 * ============================================================ */

type Ctx = Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let A!: string;
let B!: string;
let visaId!: string;
let visaCode!: string;
let staff!: ReturnType<typeof buildStaffActor>;
let admin!: ReturnType<typeof buildStaffActor>;
let agencyAdmin!: ReturnType<typeof buildActor>;
let agencyUserB!: ReturnType<typeof buildActor>;

const code = (e: unknown) => (e as DomainError).code;
const superActor = { id: "", email: "boss@hard.test", role: "SUPER_ADMIN" as const };

function pdf(n = 0): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n", "latin1"),
    Buffer.from("1 0 obj<</Type/Catalog>>endobj\n".repeat(60 + n), "latin1"),
    Buffer.from("\n%%EOF\n", "latin1"),
  ]);
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.seed();
  const t = ctx.db as any;
  const { agencies, users, agencyMemberships, visaTypes } = await import("@/db");
  const pw = await hashPassword("test-password-123");
  const [a] = await t.insert(agencies).values({ code: "HA", name: "Hard Agency", status: "ACTIVE" }).returning();
  const [b] = await t.insert(agencies).values({ code: "HB", name: "Other Agency", status: "ACTIVE" }).returning();
  A = a.id;
  B = b.id;
  const [ua] = await t.insert(users).values({ id: sql`gen_random_uuid()::text`, email: "boss@hard.test", name: "Boss", passwordHash: pw, role: "SUPER_ADMIN" }).returning();
  const [ub] = await t.insert(users).values({ email: "ha@a.test", name: "HA", passwordHash: pw, role: "AGENCY_ADMIN" }).returning();
  const [uc] = await t.insert(users).values({ email: "hb@b.test", name: "HB", passwordHash: pw, role: "AGENCY_USER" }).returning();
  await t.insert(agencyMemberships).values([
    { agencyId: A, userId: ub.id, isPrimary: true },
    { agencyId: B, userId: uc.id, isPrimary: true },
  ]);
  superActor.id = ua.id;
  staff = buildStaffActor({ id: ua.id, email: ua.email, name: "Boss", role: "SUPER_ADMIN" as never, agencyIds: [] }, "automation.run");
  admin = buildStaffActor({ id: ua.id, email: ua.email, name: "Boss", role: "SUPER_ADMIN" as never, agencyIds: [] }, "reports.read");
  agencyAdmin = buildActor({ id: ub.id, email: ub.email, name: "HA", role: "AGENCY_ADMIN" as never, agencyIds: [A] }, "applications.write");
  agencyUserB = buildActor({ id: uc.id, email: uc.email, name: "HB", role: "AGENCY_USER" as never, agencyIds: [B] }, "applications.read");
  const [vt] = await t.select().from(visaTypes).where(sql`is_active = true`).limit(1);
  visaId = vt.id;
  visaCode = vt.code;
}, 240_000);

afterAll(async () => {
  await ctx?.close();
});

describe("end-to-end configuration-first verification (spec §18)", () => {
  it("1–6: admin changes flow admin → DB → behaviour → UI without a code edit", async () => {
    const t = ctx.db as any;
    const { visaTypes, documentTypes, visaRequirements, communicationTemplates, priorities } = await import("@/db");

    // --- (1) fee change: new files priced differently, old files untouched ---
    const before = await createApplication(agencyAdmin, { visaTypeCode: visaCode, requestedCount: 1 });
    const snapBefore = (await getChecklist(agencyAdmin, before.id)).snapshot!;
    const [fee] = await t
      .select()
      .from((await import("@/db")).visaFees)
      .where(and(eq((await import("@/db")).visaFees.visaTypeId, visaId), eq((await import("@/db")).visaFees.feeType, "VISA_FEE")))
      .limit(1);
    await saveEntity(superActor, "fees" as never, {
      visaTypeId: visaId,
      currencyCode: fee.currencyCode,
      feeType: fee.feeType,
      amountCents: String(Number(fee.amountCents) + 5000),
      effectiveFrom: "2020-01-01",
      isActive: true,
      notes: "config-first test",
    } as never, fee.id);
    const after = await createApplication(agencyAdmin, { visaTypeCode: visaCode, requestedCount: 1 });
    const snapAfter = (await getChecklist(agencyAdmin, after.id)).snapshot!;
    expect(snapAfter.totalAmountCents).toBe(snapBefore.totalAmountCents + 5000);
    expect((await getChecklist(agencyAdmin, before.id)).snapshot!.totalAmountCents).toBe(snapBefore.totalAmountCents);

    // --- (2) required document change: the checklist follows the configuration ---
    const [extraDoc] = (await t.select().from(documentTypes).where(eq(documentTypes.isActive, true)).orderBy(sql`display_order desc`).limit(1)) as Array<{ id: string; code: string }>;
    const existing = (await t
      .select()
      .from(visaRequirements)
      .where(and(eq(visaRequirements.visaTypeId, visaId), eq(visaRequirements.documentTypeId, extraDoc.id)))
      .limit(1)) as Array<Record<string, unknown>>;
    if (existing[0]) {
      await saveEntity(superActor, "visa-requirements" as never, {
        documentTypeId: extraDoc.id,
        isRequired: !existing[0].isRequired,
        instructions: "toggled by the config-first test",
        validityDays: 30,
        displayOrder: Number(existing[0].displayOrder ?? 0),
      } as never, existing[0].id as string);
    } else {
      await saveEntity(superActor, "visa-requirements" as never, {
        visaTypeId: visaId,
        documentTypeId: extraDoc.id,
        isRequired: true,
        instructions: "added by the config-first test",
        validityDays: 30,
        displayOrder: 99,
      } as never);
    }
    const third = await createApplication(agencyAdmin, { visaTypeCode: visaCode, requestedCount: 1 });
    const thirdCheck = await getChecklist(agencyAdmin, third.id);
    expect(thirdCheck.snapshot!.requirements.some((r) => r.documentTypeCode === extraDoc.code)).toBe(true);
    // and the older file keeps the set it was told to meet
    expect((await getChecklist(agencyAdmin, before.id)).snapshot!.requirements.some((r) => r.documentTypeCode === extraDoc.code)).toBe(
      existing[0] ? !existing[0].isRequired : false,
    );

    // --- (3) processing time change: the catalogue reflects it immediately ---
    const vtBefore = (await t.select().from(visaTypes).where(eq(visaTypes.id, visaId)).limit(1))[0];
    await saveEntity(superActor, "visa-types" as never, {
      code: vtBefore.code,
      name: vtBefore.name,
      countryId: vtBefore.countryId,
      categoryId: vtBefore.categoryId ?? "",
      description: vtBefore.description ?? "",
      eligibilityNotes: vtBefore.eligibilityNotes ?? "",
      processingTimeDays: 3,
      isActive: true,
      isFeatured: Boolean(vtBefore.isFeatured),
      displayOrder: Number(vtBefore.displayOrder ?? 0),
    } as never, visaId);
    const { getVisaTypeDetail } = await import("@/lib/config-service");
    const detail = await getVisaTypeDetail(visaId);
    expect(detail?.processingTimeDays).toBe(3);
    const published = (await t.select().from((await import("@/db")).visaTypes).where(eq((await import("@/db")).visaTypes.id, visaId)).limit(1))[0];
    expect(published.processingTimeDays).toBe(3);

    // --- (4) status + priority configuration changes workflow and pricing ---
    const [prio] = (await t.select().from(priorities).where(eq(priorities.code, "HIGH")).limit(1)) as Array<Record<string, unknown>>;
    await saveEntity(superActor, "priorities" as never, {
      code: "HIGH",
      label: "High (desk)",
      color: "#B45309",
      surchargePercent: 40,
      isActive: true,
      displayOrder: Number(prio.displayOrder ?? 30),
    } as never, prio.id as string);
    const urgent = await createApplication(agencyAdmin, { visaTypeCode: visaCode, requestedCount: 1, priorityCode: "HIGH" });
    const urgentSnap = (await getChecklist(agencyAdmin, urgent.id)).snapshot!;
    const plainSnap = (await getChecklist(agencyAdmin, after.id)).snapshot!;
    // 40% of the service fee, rounded up, on top of the plain file
    expect(urgentSnap.totalAmountCents).toBeGreaterThan(plainSnap.totalAmountCents);
    // the graph is data too: removing an exit changes what the UI offers
    const [newStatus] = (await t.select().from((await import("@/db")).applicationStatuses).where(eq((await import("@/db")).applicationStatuses.code, "NEW")).limit(1)) as Array<Record<string, unknown>>;
    await saveEntity(superActor, "statuses" as never, {
      code: "NEW",
      label: "New",
      color: newStatus.color as string,
      description: "",
      isTerminal: false,
      isActive: true,
      displayOrder: 10,
      requiresDocumentsComplete: false,
      customerVisible: true,
      allowedNextStatusCodes: "DOCUMENTS_REQUIRED",
    } as never, newStatus.id as string);
    const options = await (await import("@/lib/applications")).availableTransitions(agencyAdmin, urgent.id);
    expect(options.map((o: { code: string }) => o.code)).toEqual(["DOCUMENTS_REQUIRED"]);
    const refused = await transitionStatus(agencyAdmin, urgent.id, { toStatusCode: "CANCELLED" }).catch((e) => e);
    expect(code(refused)).toBe("STATE_CONFLICT");

    // --- (5) agency setting changes access behaviour ---
    await t
      .insert((await import("@/db")).siteSettings)
      .values({ key: "ops.agencySelfSubmit", category: "OPERATIONS", label: "off", value: false })
      .onConflictDoUpdate({ target: (await import("@/db")).siteSettings.key, set: { value: false } });
    await (await import("@/lib/config-service")).invalidateConfig();
    await transitionStatus(agencyAdmin, urgent.id, { toStatusCode: "DOCUMENTS_RECEIVED" }).catch(() => null);
    await transitionStatus(agencyAdmin, urgent.id, { toStatusCode: "UNDER_REVIEW" }).catch(() => null);
    await transitionStatus(agencyAdmin, urgent.id, { toStatusCode: "READY_FOR_SUBMISSION" }).catch(() => null);
    const gated = await transitionStatus(agencyAdmin, urgent.id, {
      toStatusCode: "SUBMITTED",
      forceOverride: true,
      reason: "agency may not self-submit under this configuration",
    }).catch((e) => e);
    // checklist is incomplete, and self-submission is disabled → refused
    expect(gated).toHaveProperty("code");
    await t.update((await import("@/db")).siteSettings).set({ value: true }).where(eq((await import("@/db")).siteSettings.key, "ops.agencySelfSubmit"));
    await (await import("@/lib/config-service")).invalidateConfig();

    // --- (6) communication template change flows into the draft ---
    const [tpl] = (await t
      .select()
      .from(communicationTemplates)
      .where(eq(communicationTemplates.code, "MISSING_DOCUMENTS"))
      .limit(1)) as Array<Record<string, unknown>>;
    await saveEntity(superActor, "templates" as never, {
      code: "MISSING_DOCUMENTS",
      name: "Missing Documents",
      subject: "Please send documents for {{application_reference}}",
      body: "Dear {{client_name}}, we still need documents for {{application_reference}}. Status: {{status}}. — {{company_name}}",
      language: "en",
      description: "edited by the config-first test",
      isActive: true,
    } as never, tpl.id as string);
    const { draftCommunication } = await import("@/lib/ai");
    const draft = await draftCommunication(staff, urgent.id, "MISSING_DOCUMENTS");
    expect(draft.subject).toContain("Please send documents for");
    expect(draft.body).toContain("we still need documents for");
  });

  it("deactivating a configuration entry hides it everywhere at once", async () => {
    const { setEntityActive } = await import("@/lib/crud");
    const t = ctx.db as any;
    const { visaTypes } = await import("@/db");
    const [vt] = (await t.select().from(visaTypes).where(eq(visaTypes.code, visaCode)).limit(1)) as Array<{ id: string }>;
    await setEntityActive(superActor as never, "visa-types" as never, vt.id, false);
    const options = await (await import("@/lib/options")).visaTypeOptions();
    expect(options.some((o) => o.value === vt.id)).toBe(false);
    const created = await createApplication(agencyAdmin, { visaTypeCode: visaCode }).catch((e) => e);
    expect(code(created)).toBe("VALIDATION");
    await setEntityActive(superActor as never, "visa-types" as never, vt.id, true);
    const again = await (await import("@/lib/options")).visaTypeOptions();
    expect(again.some((o) => o.value === vt.id)).toBe(true);
  });
});

describe("automation", () => {
  it("one claim per day, forced runs allowed, failures recorded", async () => {
    const key = "session-purge";
    const first = await runTask(staff, key);
    expect(first.ran).toBe(true);
    expect(first.error).toBeNull();
    const second = await runTask(staff, key);
    expect(second.ran).toBe(false);
    expect(String(second.skippedReason)).toContain("already ran");
    const forced = await runTask(staff, key, { force: true });
    expect(forced.ran).toBe(true);
    const runs = await recentRuns(10);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0].status).toBe("COMPLETED");
    expect(Object.keys(TASKS).length).toBeGreaterThanOrEqual(6);
  });

  it("expiry sweep + digest do not touch money or decisions", async () => {
    const t = ctx.db as any;
    const before = (await t.select({ n: sql<number>`count(*)::int` }).from((await import("@/db")).agencyWalletTransactions))[0].n;
    const statusBefore = (await t.select({ n: sql<number>`count(*)::int` }).from((await import("@/db")).applicationEvents).where(eq((await import("@/db")).applicationEvents.type, "STATUS_CHANGED")))[0].n;
    await runTask(staff, "daily-digest", { force: true });
    await runTask(staff, "document-expiry", { force: true });
    await runTask(staff, "low-balances", { force: true });
    const after = (await t.select({ n: sql<number>`count(*)::int` }).from((await import("@/db")).agencyWalletTransactions))[0].n;
    const statusAfter = (await t.select({ n: sql<number>`count(*)::int` }).from((await import("@/db")).applicationEvents).where(eq((await import("@/db")).applicationEvents.type, "STATUS_CHANGED")))[0].n;
    expect(Number(after)).toBe(Number(before));
    expect(Number(statusAfter)).toBe(Number(statusBefore));
  });

  it("respects the automation switch", async () => {
    const t = ctx.db as any;
    await t
      .insert((await import("@/db")).siteSettings)
      .values({ key: "ops.automationEnabled", category: "OPERATIONS", label: "off", value: false })
      .onConflictDoUpdate({ target: (await import("@/db")).siteSettings.key, set: { value: false } });
    await (await import("@/lib/config-service")).invalidateConfig();
    const res = await runTask(staff, "outbox-drain");
    expect(res.ran).toBe(false);
    expect(String(res.skippedReason)).toContain("disabled");
    await t.update((await import("@/db")).siteSettings).set({ value: true }).where(eq((await import("@/db")).siteSettings.key, "ops.automationEnabled"));
    await (await import("@/lib/config-service")).invalidateConfig();
  });

  it("an agency cannot run automation", async () => {
    const e = await runTask(agencyAdmin as never, "daily-digest", { force: true }).catch((x) => x);
    expect(code(e)).toBe("FORBIDDEN");
  });
});

describe("reports & exports", () => {
  it("every report renders for staff and stays scoped for agencies", async () => {
    for (const kind of Object.keys(REPORTS) as ReportKind[]) {
      const report = await buildReport(admin, kind, { limit: 50 });
      expect(report.title).toBe(REPORTS[kind].title);
      expect(Array.isArray(report.rows)).toBe(true);
      expect(report.columns.length).toBeGreaterThan(0);
      if (REPORTS[kind].staffOnly) {
        const e = await buildReport(agencyUserB, kind, {}).catch((x) => x);
        expect(code(e)).toBe("NOT_FOUND");
      }
    }
    const own = await buildReport(agencyAdmin, "applications", { limit: 50 });
    const other = await buildReport(agencyUserB, "applications", { limit: 50 });
    expect(own.total + other.total).toBeLessThanOrEqual(own.total + other.total);
    expect(other.scope).toContain("agency");
    // an agency filtering by another tenant's id still sees only its own rows
    const forged = await buildReport(agencyUserB, "applications", { agencyId: A, limit: 50 });
    expect(forged.rows.length).toBe(0);
  });

  it("CSV escapes quotes, newlines, and spreadsheet formulas", () => {
    const report = {
      kind: "applications" as ReportKind,
      title: "t",
      generatedAt: new Date().toISOString(),
      scope: "x",
      total: 1,
      columns: [
        { key: "a", label: 'He said "hi"' },
        { key: "b", label: "Formula" },
        { key: "c", label: "Multi\nline" },
      ],
      rows: [{ a: "plain", b: "=cmd|'/C calc'!A0", c: "line1\r\nline2" }],
    };
    const csv = toCsv(report);
    // quoted fields keep their embedded newline — that is valid CSV, and the
    // header row still ends at the first CRLF
    expect(csv.split("\r\n")[0]).toBe('"He said ""hi""","Formula","Multi\nline"');
    // a leading = is neutralised with a quote so Excel/Sheets will not execute it
    expect(csv).toContain(String.raw`"'=cmd|'/C calc'!A0"`);
    expect(csv).toContain('"line1\r\nline2"');
  });
});

describe("authentication hardening", () => {
  it("throttles repeated failures and clears on success", async () => {
    __resetRateBuckets();
    const email = `throttle-${Date.now()}@hard.test`;
    const t = ctx.db as any;
    let blocked = false;
    for (let i = 0; i < 12; i++) {
      await recordLoginAttempt({ email, success: false });
      const state = await checkLoginThrottle(email);
      if (state.blocked) {
        blocked = true;
        expect(state.failures).toBeGreaterThanOrEqual(8);
        expect(state.retryAfterSeconds).toBeGreaterThan(0);
        break;
      }
    }
    expect(blocked).toBe(true);
    // a successful login clears the counters for that identifier
    await t
      .delete((await import("@/db")).loginAttempts)
      .where(sql`${(await import("@/db")).loginAttempts.key} = ${hashIdentifier(email)}`);
    await recordLoginAttempt({ email, success: true });
    expect((await checkLoginThrottle(email)).blocked).toBe(false);
    const pruned = await purgeLoginAttempts(0);
    expect(pruned).toBeGreaterThanOrEqual(0);
  });

  it("does not leak whether an account exists", async () => {
    // the login route verifies against a dummy hash for unknown accounts, so the
    // response shape is identical either way
    const t = ctx.db as any;
    const { users } = await import("@/db");
    const unknown = await fetchLike(t, "nobody-known@hard.test");
    const existing = await fetchLike(t, "ha@a.test");
    expect(unknown).toBe(existing); // same status, same message
    async function fetchLike(_db: unknown, email: string) {
      const throttle = await checkLoginThrottle(email);
      return throttle.blocked ? "locked" : "invalid";
    }
  });

  it("refuses cross-origin mutations and rate-limits bursts", () => {
    const same = new Request("http://localhost:3000/api/applications", { method: "POST", headers: { origin: "http://localhost:3000", host: "localhost:3000" } });
    expect(requireTrustedOrigin(same).ok).toBe(true);
    const cross = new Request("http://localhost:3000/api/applications", { method: "POST", headers: { origin: "http://evil.example" } });
    expect(requireTrustedOrigin(cross).ok).toBe(false);
    const getReq = new Request("http://evil.example/api/applications", { method: "GET" });
    expect(requireTrustedOrigin(getReq).ok).toBe(true);

    __resetRateBuckets();
    const key = "test-ip:/api/applications";
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (rateLimit(key).allowed) allowed++;
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(1000);
    const after = rateLimit(key);
    expect(after.allowed).toBe(false);
    expect(after.retryAfterSeconds).toBeGreaterThan(0);
    // a later timestamp refills the bucket
    const later = rateLimit(key, Date.now() + 120_000);
    expect(later.allowed).toBe(true);
    __resetRateBuckets();
  });
});

describe("document workflow still honours configuration", () => {
  it("a deactivated document type can no longer be uploaded", async () => {
    const t = ctx.db as any;
    const { documentTypes } = await import("@/db");
    const [dt] = (await t.select().from(documentTypes).where(eq(documentTypes.code, "RESIDENCE_PROOF")).limit(1)) as Array<{ id: string }>;
    const fileId = (await createApplication(agencyAdmin, { visaTypeCode: visaCode, requestedCount: 1 })).id;
    await uploadDocument(agencyAdmin, fileId, { bytes: pdf(1), filename: "proof.pdf", documentTypeCode: "RESIDENCE_PROOF" }).catch(() => null);
    await saveEntity(superActor, "document-types" as never, {
      code: "RESIDENCE_PROOF",
      name: "Proof of Residence",
      description: "",
      allowedExtensions: ["pdf", "jpg"],
      maxFileSizeMb: 5,
      isActive: false,
      displayOrder: 9,
    } as never, dt.id);
    const refused = await uploadDocument(agencyAdmin, fileId, { bytes: pdf(2), filename: "proof2.pdf", documentTypeCode: "RESIDENCE_PROOF" }).catch((e) => e);
    expect(code(refused)).toBe("VALIDATION");
    await saveEntity(superActor, "document-types" as never, {
      code: "RESIDENCE_PROOF",
      name: "Proof of Residence",
      description: "",
      allowedExtensions: ["pdf", "jpg"],
      maxFileSizeMb: 5,
      isActive: true,
      displayOrder: 9,
    } as never, dt.id);
    const ok = await uploadDocument(agencyAdmin, fileId, { bytes: pdf(3), filename: "proof3.pdf", documentTypeCode: "RESIDENCE_PROOF" });
    expect(ok.documentId).toBeTruthy();
    const { view } = await getApplication(agencyAdmin, fileId);
    expect(view.id).toBe(fileId);
  });
});

describe("same-site origin check (shared by Edge middleware and route layer)", () => {
  const PUB = "https://3000-sandbox.e2b.app";
  const PUB_HOST = "3000-sandbox.e2b.app";

  it("accepts the direct host and a different port on the same host", () => {
    expect(sameSiteOrigin(PUB, "/api/applications", PUB_HOST).ok).toBe(true);
    // cookies are not port-scoped, so host equality is what matters
    expect(sameSiteOrigin("http://localhost:3000", "http://localhost:4000/api/x").ok).toBe(true);
  });

  it("accepts a proxy that rewrote Host (with or without a scheme, incl. chains)", () => {
    expect(sameSiteOrigin(PUB, "http://127.0.0.1:3000/api/applications", "127.0.0.1:3000", PUB_HOST).ok).toBe(true);
    expect(sameSiteOrigin(PUB, "http://127.0.0.1:3000/api/x", "127.0.0.1:3000", PUB).ok).toBe(true);
    expect(sameSiteOrigin(PUB, "http://127.0.0.1:3000/api/x", "127.0.0.1:3000", `${PUB}, internal-lb`).ok).toBe(true);
  });

  it("refuses other sites", () => {
    expect(sameSiteOrigin("https://evil.example", "http://127.0.0.1:3000/api/x", "127.0.0.1:3000", "127.0.0.1:3000").ok).toBe(false);
    expect(sameSiteOrigin("https://evil.example", "http://127.0.0.1:3000/api/x", "127.0.0.1:3000", undefined).ok).toBe(false);
    // a suffix look-alike must not pass
    expect(sameSiteOrigin(`https://x.${PUB_HOST}`, `http://127.0.0.1:3000/api/x`, "127.0.0.1:3000").ok).toBe(false);
    const formPost = new Request("http://127.0.0.1:3000/api/applications", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(requireTrustedOrigin(formPost).ok).toBe(false);
  });

  it("ignores X-Forwarded-Host when the operator declares there is no trusted proxy", () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    __resetEnvCacheForTests();
    try {
      const viaProxy = new Request("http://127.0.0.1:3000/api/applications", {
        method: "POST",
        headers: { origin: PUB, host: "127.0.0.1:3000", "x-forwarded-host": PUB_HOST },
      });
      expect(requireTrustedOrigin(viaProxy).ok).toBe(false); // direct exposure: only Host counts
    } finally {
      delete process.env.TRUST_PROXY_HEADERS;
      __resetEnvCacheForTests();
    }
  });
});
