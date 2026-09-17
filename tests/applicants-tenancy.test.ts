import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers";
import { hashPassword } from "@/lib/password";
import { buildActor, buildStaffActor } from "@/lib/guard";
import { createApplication, getApplication, updateApplication, appendNote, assignCaseOfficer, getChecklist } from "@/lib/applications";
import { listApplicants, removeApplicant, upsertApplicant } from "@/lib/applicants";
import { creditWallet, ensureInvoiceForApplication, chargeApplication, getInvoiceForApplication } from "@/lib/billing";
import { DomainError } from "@/lib/ops";

type Ctx = Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let A: string; // agency A id
let B: string;
let appA: string; // application owned by A
let applicantA: string;
let appB: string;
let actorA: ReturnType<typeof buildActor>;
let actorB: ReturnType<typeof buildActor>;
let visaCode: string;
let adminUser: { id: string; email: string; role: string };

const code = (e: unknown) => (e as DomainError).code;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.seed();
  const t = ctx.db as any;
  const { agencies, users, agencyMemberships, visaTypes } = await import("@/db");
  const pw = await hashPassword("test-password-123");
  const [a] = await t.insert(agencies).values({ code: "PA", name: "Partner A", status: "ACTIVE" }).returning();
  const [b] = await t.insert(agencies).values({ code: "PB", name: "Partner B", status: "ACTIVE" }).returning();
  A = a.id;
  B = b.id;
  const [ua] = await t.insert(users).values({ email: "pa@a.test", name: "PA", passwordHash: pw, role: "AGENCY_ADMIN" }).returning();
  const [ub] = await t.insert(users).values({ email: "pb@b.test", name: "PB", passwordHash: pw, role: "AGENCY_ADMIN" }).returning();
  const [uc] = await t.insert(users).values({ email: "pu@a.test", name: "PU", passwordHash: pw, role: "AGENCY_USER" }).returning();
  await t.insert(agencyMemberships).values([
    { agencyId: A, userId: ua.id, isPrimary: true },
    { agencyId: B, userId: ub.id, isPrimary: true },
    { agencyId: A, userId: uc.id, isPrimary: true },
  ]);
  adminUser = { id: ua.id, email: ua.email, role: ua.role };
  const [vt] = await t.select({ code: visaTypes.code }).from(visaTypes).where(sql`is_active = true`).limit(1);
  visaCode = vt.code;
  actorA = buildActor({ id: ua.id, email: ua.email, name: "PA", role: "AGENCY_ADMIN", agencyIds: [A] }, "applications.write");
  actorB = buildActor({ id: ub.id, email: ub.email, name: "PB", role: "AGENCY_ADMIN", agencyIds: [B] }, "applications.write");

  appA = (await createApplication(actorA, { visaTypeCode: visaCode, requestedCount: 2 })).id;
  applicantA = (await upsertApplicant(actorA, appA, { fullName: "Alice Passport", passportNumber: "X12345678", passportExpiryDate: "2030-01-01", dateOfBirth: "1990-05-05" })).id;
  appB = (await createApplication(actorB, { visaTypeCode: visaCode, requestedCount: 1 })).id;
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe("applicants (Phase 4)", () => {
  it("links travellers to the file, expands the checklist and re-prices", async () => {
    const created = await createApplication(actorA, { visaTypeCode: visaCode, requestedCount: 1 });
    const before = await getChecklist(actorA, created.id);
    const reqBefore = before.snapshot!.requirements.filter((r: any) => r.isRequired).length;
    expect(before.requiredTotal).toBe(reqBefore);

    await upsertApplicant(actorA, created.id, { fullName: "First Traveller", passportNumber: "AAA111", passportExpiryDate: "2031-01-01", dateOfBirth: "1988-01-01" });
    const afterOne = await getChecklist(actorA, created.id);
    expect(afterOne.requiredTotal).toBe(reqBefore); // one applicant → same slot count

    await upsertApplicant(actorA, created.id, { fullName: "Second Traveller", passportNumber: "BBB222", passportExpiryDate: "2031-01-01", dateOfBirth: "1988-01-01" });
    const afterTwo = await getChecklist(actorA, created.id);
    expect(afterTwo.requiredTotal).toBe(reqBefore * 2);

    // headcount drives the price, so the invoice for the file follows it
    const one = await ensureInvoiceForApplication(created.id);
    await upsertApplicant(actorA, created.id, { fullName: "Third Traveller", passportNumber: "CCC333", passportExpiryDate: "2031-01-01", dateOfBirth: "1988-01-01" });
    const three = await ensureInvoiceForApplication(created.id);
    expect(three.invoiceId).toBe(one.invoiceId);
    expect(three.subtotalCents).toBeGreaterThan(one.subtotalCents);

    // applicantCount cache stays truthful
    const { view } = await getApplication(actorA, created.id);
    expect(view.applicantCount).toBe(3);
  });

  it("rejects a forged applicant id from another file or another tenant", async () => {
    // wrong application, right agency
    const other = await createApplication(actorA, { visaTypeCode: visaCode });
    await expect(
      upsertApplicant(actorA, other.id, { fullName: "Ghost", passportExpiryDate: "2030-01-01" }, applicantA),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // another tenant tries to edit A's applicant through its own file
    await expect(
      upsertApplicant(actorB, appB, { fullName: "Hijack", passportExpiryDate: "2030-01-01" }, applicantA),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(removeApplicant(actorB, appB, applicantA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // and cannot even enumerate them
    await expect(listApplicants(actorB, appA)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deduplicates passports inside a tenant but not across tenants", async () => {
    const dup = await upsertApplicant(actorA, appA, { fullName: "Same Book", passportNumber: "X12345678", passportExpiryDate: "2030-01-01" }).catch((e) => e);
    expect(code(dup)).toBe("DUPLICATE");
    // B may use the same passport number on its own file (no cross-tenant oracle)
    const other = await upsertApplicant(actorB, appB, { fullName: "Same Book B", passportNumber: "X12345678", passportExpiryDate: "2030-01-01" });
    expect(other.id).toBeTruthy();
  });

  it("validates dates instead of accepting whatever the client sent", async () => {
    await expect(
      upsertApplicant(actorA, appA, { fullName: "Bad Dates", passportIssueDate: "2030-01-01", passportExpiryDate: "2020-01-01" }),
    ).rejects.toBeTruthy();
    await expect(upsertApplicant(actorA, appA, { fullName: "Expired", passportExpiryDate: "2020-01-01" })).rejects.toBeTruthy();
    await expect(upsertApplicant(actorA, appA, { fullName: "Wrong Country", nationalityCountryCode: "ZZ" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("refuses to drop requested count below the applicants on file", async () => {
    const created = await createApplication(actorA, { visaTypeCode: visaCode, requestedCount: 3 });
    await upsertApplicant(actorA, created.id, { fullName: "Keep One", passportNumber: "K100001", passportExpiryDate: "2031-02-02", dateOfBirth: "1991-01-01" });
    await upsertApplicant(actorA, created.id, { fullName: "Keep Two", passportNumber: "K200002", passportExpiryDate: "2031-02-02", dateOfBirth: "1991-01-01" });
    await upsertApplicant(actorA, created.id, { fullName: "Keep Three", passportNumber: "K300003", passportExpiryDate: "2031-02-02", dateOfBirth: "1991-01-01" });
    await expect(updateApplication(actorA, created.id, { requestedCount: 2 })).rejects.toMatchObject({ code: "VALIDATION" });
    await updateApplication(actorA, created.id, { requestedCount: 5 });
    const { view } = await getApplication(actorA, created.id);
    expect(view.requestedCount).toBe(5);
    expect(view.applicantCount).toBe(3);
  });
});

describe("state-aware editing and role boundaries (Phase 4)", () => {
  it("pins agencies to the intake status for edits", async () => {
    const created = await createApplication(actorA, { visaTypeCode: visaCode });
    await upsertApplicant(actorA, created.id, { fullName: "Trav", passportExpiryDate: "2030-01-01", dateOfBirth: "1990-01-01" });
    // staff moves it onward
    const staff = buildStaffActor({ id: adminUser.id, email: adminUser.email, name: "Ops", role: "SUPER_ADMIN", agencyIds: [] }, "applications.override");
    const { transitionStatus } = await import("@/lib/applications");
    await transitionStatus(staff, created.id, { toStatusCode: "DOCUMENTS_RECEIVED" });
    await expect(updateApplication(actorA, created.id, { notes: "late edit" })).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    await expect(
      upsertApplicant(actorA, created.id, { fullName: "Late Traveller", passportExpiryDate: "2030-01-01" }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("does not let an agency write staff-only columns even if it sends them", async () => {
    await expect(updateApplication(actorA, appA, { staffNotes: "I am the staff now" } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(updateApplication(actorA, appA, { caseOfficerUserId: adminUser.id } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("keeps agency staff accounts out of case-officer assignment", async () => {
    const staff = buildStaffActor({ id: adminUser.id, email: adminUser.email, name: "Ops", role: "SUPER_ADMIN", agencyIds: [] }, "applications.assign");
    await expect(assignCaseOfficer(staff, appA, adminUser.id)).rejects.toMatchObject({ code: "VALIDATION" });
    await assignCaseOfficer(staff, appA, null);
    const t = ctx.db as any;
    const { visaApplications } = await import("@/db");
    const [row] = await t.select().from(visaApplications).where(eq(visaApplications.id, appA)).limit(1);
    expect(row.caseOfficerUserId).toBeNull();
  });

  it("an AGENCY_USER may write its own file but not send messages marked internal", async () => {
    const { users } = await import("@/db");
    const t = ctx.db as any;
    const [pu] = (await t.select().from(users).where(eq(users.email, "pu@a.test")).limit(1)) as Array<{ id: string; email: string; role: string }>;
    const plain = buildActor({ id: pu.id, email: pu.email, name: "PU", role: pu.role as never, agencyIds: [A] }, "applications.write");
    await appendNote(plain, appA, { body: "Visible message from the agency", customerVisible: true });
    await expect(appendNote(plain, appA, { body: "sneaky internal", customerVisible: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(plain).toBeTruthy();
  });

  it("freezes the invoice once money has moved", async () => {
    const created = await createApplication(actorA, { visaTypeCode: visaCode, requestedCount: 1 });
    await upsertApplicant(actorA, created.id, { fullName: "Priced Traveller", passportExpiryDate: "2030-01-01", dateOfBirth: "1990-01-01" });
    const staff = buildStaffActor({ id: adminUser.id, email: adminUser.email, name: "Ops", role: "SUPER_ADMIN", agencyIds: [] }, "wallet.write");
    const inv = await ensureInvoiceForApplication(created.id, undefined, { actor: staff });
    await creditWallet(staff, { agencyId: A, amountCents: inv.subtotalCents * 3, currencyCode: "EUR", reason: "float for frozen-invoice test", idempotencyKey: "frozen-1" });
    await chargeApplication(staff, created.id);
    const before = await getInvoiceForApplication(created.id);
    // adding a traveller afterwards must NOT rewrite a paid invoice
    await upsertApplicant(actorA, created.id, { fullName: "Extra Traveller", passportExpiryDate: "2030-01-01", dateOfBirth: "1990-01-01" });
    const after = await getInvoiceForApplication(created.id);
    expect(after?.subtotalCents).toBe(before?.subtotalCents);
    expect(after?.items.length).toBe(before?.items.length);
  });
});

describe("a closed file is frozen for traveller changes", () => {
  it("refuses applicant additions and removals in a terminal status", async () => {
    const t = ctx.db as any;
    const { visaApplications, applicationStatuses } = await import("@/db");
    const created = await createApplication(actorA, { visaTypeCode: visaCode, requestedCount: 1 });
    const ap = await upsertApplicant(actorA, created.id, { fullName: "Closing Traveller", passportExpiryDate: "2030-01-01", dateOfBirth: "1990-01-01" });

    // status is set directly on purpose: this test isolates the freeze rule, not the
    // status graph (the graph itself is proven in applications-lifecycle.test.ts)
    const [terminal] = (await t
      .select({ id: applicationStatuses.id })
      .from(applicationStatuses)
      .where(eq(applicationStatuses.isTerminal, true))
      .limit(1)) as Array<{ id: string }>;
    expect(terminal).toBeTruthy();
    await t.update(visaApplications).set({ statusId: terminal.id }).where(eq(visaApplications.id, created.id));

    await expect(
      upsertApplicant(actorA, created.id, { fullName: "Too Late", passportExpiryDate: "2031-01-01", dateOfBirth: "1990-01-01" }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    await expect(removeApplicant(actorA, created.id, ap.id)).rejects.toMatchObject({ code: "STATE_CONFLICT" });

    // the traveller already on the file is untouched by the refusal
    const list = await listApplicants(actorA, created.id);
    expect(list).toHaveLength(1);
  });
});
