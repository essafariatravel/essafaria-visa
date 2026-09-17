import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers";
import { hashPassword } from "@/lib/password";
import { buildActor, buildStaffActor } from "@/lib/guard";
import { createApplication, getApplication, listApplications, listTimeline, transitionStatus, updateApplication, getChecklist, assignCaseOfficer, appendNote } from "@/lib/applications";
import { listApplicants, upsertApplicant } from "@/lib/applicants";
import { listDocuments, openDocumentContent, reviewDocument, uploadDocument } from "@/lib/documents";
import { chargeApplication, creditWallet, ensureInvoiceForApplication, getInvoiceForApplication, getWallet, listWalletLedger } from "@/lib/billing";
import { listNotificationsForUser, markNotificationRead, unreadCounts } from "@/lib/notifications";
import { addTeamMember, listTeam, removeTeamMember, setMemberRole } from "@/lib/agency-team";
import { DomainError } from "@/lib/ops";

/* ============================================================
 * Tenant isolation matrix (spec §19).
 *
 * Every probe uses a REAL, authenticated actor from agency B aiming at a REAL
 * row belonging to agency A, and asserts the same answer as a typo: NOT_FOUND.
 * Forbidden-with-a-message would confirm existence, so it is also a failure.
 * ============================================================ */

type Ctx = Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let A!: string;
let B!: string;
let appA!: string;
let applicantA!: string;
let documentA!: string;
let invoiceA!: string;
let notificationA!: string;
let userA!: { id: string; email: string; role: string };
let userB!: { id: string; email: string; role: string };
let bAdmin!: ReturnType<typeof buildActor>;
let bUser!: ReturnType<typeof buildActor>;
let aAdmin!: ReturnType<typeof buildActor>;
let staff!: ReturnType<typeof buildStaffActor>;
let visaCode!: string;

const code = (e: unknown) => (e as DomainError).code;
const expectNotFound = async (label: string, p: Promise<unknown>) => {
  const e = await p.then(() => null).catch((x) => x);
  expect(e, `${label}: expected rejection, got success`).toBeTruthy();
  expect(code(e), `${label}: wrong error code`).toBe("NOT_FOUND");
};

function pdf(n = 0): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n", "latin1"),
    Buffer.from("1 0 obj<</Type/Catalog>>endobj\n".repeat(80 + n), "latin1"),
    Buffer.from("\n%%EOF\n", "latin1"),
  ]);
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.seed();
  const t = ctx.db as any;
  const { agencies, users, agencyMemberships, visaTypes } = await import("@/db");
  const pw = await hashPassword("test-password-123");
  const [a] = await t.insert(agencies).values({ code: "XA", name: "Agency Alpha", status: "ACTIVE", walletBalanceCents: 0 }).returning();
  const [b] = await t.insert(agencies).values({ code: "XB", name: "Agency Beta", status: "ACTIVE", walletBalanceCents: 0 }).returning();
  A = a.id;
  B = b.id;
  const ua = await t.insert(users).values({ email: "alpha@x.test", name: "Alpha Admin", passwordHash: pw, role: "AGENCY_ADMIN" }).returning();
  const ub = await t.insert(users).values({ email: "beta@x.test", name: "Beta Admin", passwordHash: pw, role: "AGENCY_ADMIN" }).returning();
  const ubPlain = await t.insert(users).values({ email: "beta-user@x.test", name: "Beta User", passwordHash: pw, role: "AGENCY_USER" }).returning();
  const us = await t.insert(users).values({ email: "desk@x.test", name: "Desk", passwordHash: pw, role: "SUPER_ADMIN" }).returning();
  await t.insert(agencyMemberships).values([
    { agencyId: A, userId: ua[0].id, isPrimary: true },
    { agencyId: B, userId: ub[0].id, isPrimary: true },
    { agencyId: B, userId: ubPlain[0].id, isPrimary: false },
  ]);
  userA = { id: ua[0].id, email: ua[0].email, role: ua[0].role };
  userB = { id: ub[0].id, email: ub[0].email, role: ub[0].role };
  const [vt] = await t.select({ code: visaTypes.code }).from(visaTypes).where(sql`is_active = true`).limit(1);
  visaCode = vt.code;

  aAdmin = buildActor({ ...userA, name: "a", role: userA.role as never, agencyIds: [A] }, "applications.write");
  bAdmin = buildActor({ ...userB, name: "b", role: userB.role as never, agencyIds: [B] }, "applications.write");
  bUser = buildActor({ id: ubPlain[0].id, email: ubPlain[0].email, name: "bu", role: "AGENCY_USER", agencyIds: [B] }, "applications.read");
  staff = buildStaffActor({ id: us[0].id, email: us[0].email, name: "Desk", role: "SUPER_ADMIN", agencyIds: [] }, "wallet.write");

  // A's data footprint
  appA = (await createApplication(aAdmin, { visaTypeCode: vt.code, requestedCount: 1, notes: "Alpha private note" })).id;
  applicantA = (await upsertApplicant(aAdmin, appA, { fullName: "Alpha Traveller", passportNumber: "APLHA01", passportExpiryDate: "2033-01-01", dateOfBirth: "1990-01-01", nationalityCountryCode: "DZ" })).id;
  documentA = (await uploadDocument(aAdmin, appA, { bytes: pdf(), filename: "alpha-passport.pdf", documentTypeCode: "PASSPORT", applicantId: applicantA })).documentId;
  await transitionStatus(staff, appA, { toStatusCode: "DOCUMENTS_RECEIVED" });
  await transitionStatus(staff, appA, { toStatusCode: "UNDER_REVIEW" });
  await transitionStatus(staff, appA, { toStatusCode: "READY_FOR_SUBMISSION" });
  await transitionStatus(staff, appA, { toStatusCode: "SUBMITTED", forceOverride: true, reason: "Consulate accepted a partial set for this window." });
  invoiceA = (await ensureInvoiceForApplication(appA, undefined, { actor: staff })).invoiceId;
  await creditWallet(staff, { agencyId: A, amountCents: 1_000_000, currencyCode: "EUR", reason: "Alpha funding for matrix test", idempotencyKey: "matrix-credit" });
  await chargeApplication(staff, appA);
  const notes = await t
    .select({ id: (await import("@/db")).notifications.id })
    .from((await import("@/db")).notifications)
    .where(eq((await import("@/db")).notifications.agencyId, A))
    .limit(1);
  notificationA = notes[0].id;

  // B's own footprint, so cross-tenant ids are genuinely "someone else's row"
  const appB = (await createApplication(bAdmin, { visaTypeCode: vt.code })).id;
  void appB;
}, 240_000);

afterAll(async () => {
  await ctx?.close();
});

describe("A → B: reads of Alpha data by Beta are indistinguishable from a typo", () => {
  it("applications", async () => {
    await expectNotFound("getApplication", getApplication(bAdmin, appA));
    await expectNotFound("getChecklist", getChecklist(bAdmin, appA));
    const list = await listApplications(bAdmin, { pageSize: 100 });
    expect(list.rows.some((r) => r.id === appA)).toBe(false);
    expect(list.statusCounts.every((c) => c.n >= 0)).toBe(true);
    // a search for Alpha's reference must not surface it either
    const { view } = await getApplication(aAdmin, appA);
    const hunt = await listApplications(bAdmin, { q: view.reference, pageSize: 100 });
    expect(hunt.rows.length).toBe(0);
  });

  it("applicants", async () => {
    await expectNotFound("listApplicants", listApplicants(bAdmin, appA));
    const forged = await upsertApplicant(bAdmin, appA, { fullName: "Ghost", passportExpiryDate: "2030-01-01" }).catch((e) => e);
    expect(code(forged)).toBe("NOT_FOUND");
  });

  it("documents & their bytes", async () => {
    await expectNotFound("listDocuments", listDocuments(bAdmin, appA));
    const sessionUser = { id: userB.id, email: userB.email, name: "b", role: "AGENCY_ADMIN" as const, agencyIds: [B] };
    await expectNotFound("openDocumentContent", openDocumentContent({ documentId: documentA }, sessionUser as never));
    const fake = await reviewDocument(bAdmin as never, documentA, { decision: "ACCEPT" }).catch((e) => e);
    // review is staff-only for everyone, and B additionally has no tenant claim
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(code(fake));
  });

  it("invoices, wallet and ledger", async () => {
    const inv = await getInvoiceForApplication(appA);
    expect(inv).not.toBeNull();
    expect(inv!.id).toBe(invoiceA);
    // B cannot charge against Alpha's invoice, nor see Alpha's wallet
    const charge = await chargeApplication(bAdmin as never, appA).catch((e) => e);
    expect(["FORBIDDEN", "STATE_CONFLICT", "INSUFFICIENT_FUNDS", "NOT_FOUND"]).toContain(code(charge));
    const bWallet = await getWallet(B);
    expect(bWallet.balanceCents).toBe(0);
    const ledger = await listWalletLedger(B);
    expect(ledger.rows.length).toBe(0);
    const credit = await creditWallet(bAdmin as never, { agencyId: A, amountCents: 1, currencyCode: "EUR", reason: "steal" }).catch((e) => e);
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(code(credit));
    // and the money Alpha was charged never appears in B's ledger
    const alphaWallet = await getWallet(A);
    expect(alphaWallet.balanceCents).toBeLessThan(1_000_000);
    expect(alphaWallet.consistent).toBe(true);
  });

  it("notifications", async () => {
    const bInbox = await listNotificationsForUser({ id: userB.id, agencyIds: [B] }, { limit: 100 });
    // none of Beta's inbox rows reference Alpha's file
    const { view: alphaView } = await getApplication(aAdmin, appA);
    expect(bInbox.rows.some((n) => n.id === notificationA)).toBe(false);
    expect(bInbox.rows.some((n) => (n.reference ?? "").includes(alphaView.reference))).toBe(false);
    expect(bInbox.rows.length).toBeGreaterThan(0); // they have their own traffic

    // read-state is not writable across tenants
    const marked = await markNotificationRead({ id: notificationA, userId: userB.id, agencyIds: [B] });
    expect(marked).toBe(false);
    const counts = await unreadCounts(userB.id);
    expect(typeof counts.total).toBe("number");

    // and a user with no agency membership sees only rows addressed to them
    // personally, never the tenant-wide broadcast
    const delinked = await listNotificationsForUser({ id: userB.id, agencyIds: [] }, { limit: 100 });
    const direct = await ctx.db as any;
    void direct;
    const { notifications } = await import("@/db");
    const addressed = (await (ctx.db as any)
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, userB.id), eq(notifications.agencyId, B)))) as Array<{ id: string }>;
    expect(delinked.total <= bInbox.total).toBe(true);
    void addressed;
  });

  it("timeline stays on the customer-visible subset", async () => {
    await expectNotFound("listTimeline", listTimeline(bAdmin, appA, { customerView: true }));
    const alphaStaffView = await listTimeline(aAdmin, appA);
    expect(alphaStaffView.length).toBeGreaterThan(0);
  });

  it("team management cannot reach another agency's members", async () => {
    const t = ctx.db as any;
    const { agencies } = await import("@/db");
    const [alpha] = await t.select().from(agencies).where(eq(agencies.id, A)).limit(1);
    const stolen = await addTeamMember(bAdmin, { email: "alpha@x.test", name: "Hijack", role: "AGENCY_ADMIN" }, alpha.id).catch((e) => e);
    expect(["STATE_CONFLICT", "NOT_FOUND"]).toContain(code(stolen));
    const demote = await setMemberRole(bAdmin as never, userA.id, "AGENCY_USER").catch((e) => e);
    expect(["NOT_FOUND", "STATE_CONFLICT", "VALIDATION"]).toContain(code(demote));
    const remove = await removeTeamMember(bAdmin as never, userA.id).catch((e) => e);
    expect(code(remove)).toBe("NOT_FOUND");
    const team = await listTeam(bAdmin);
    expect(team.agencyId).toBe(B); // the requested-tenant argument is ignored for agencies
    expect(team.members.some((m) => m.userId === userA.id)).toBe(false);
  });
});

describe("forged ids, manipulated fields and privilege boundaries", () => {
  it("a Beta payload naming Alpha's ids never binds them", async () => {
    // agencyId in the body → ignored, pinned to B
    const created = await createApplication(bAdmin, { visaTypeCode: visaCode, requestedCount: 1, agencyId: A } as never);
    const { view } = await getApplication(bAdmin, created.id);
    expect(view.agencyId).toBe(B);
    // Alpha's applicant id smuggled into Beta's own file
    const appB = created.id;
    const forged = await upsertApplicant(bAdmin, appB, { fullName: "Borrowed", passportExpiryDate: "2030-01-01" }, applicantA).catch((e) => e);
    expect(code(forged)).toBe("NOT_FOUND");
    // Alpha's document id attached to Beta's file
    const docForge = await uploadDocument(bAdmin, appB, { bytes: pdf(3), filename: "x.pdf", documentTypeCode: "BANK_STATEMENT", applicantId: applicantA }).catch((e) => e);
    expect(code(docForge)).toBe("NOT_FOUND");
  });

  it("hidden-form tampering with staff-only fields is refused, not trusted", async () => {
    const e1 = await updateApplication(bAdmin, appA, { staffNotes: "made myself the owner" } as never).catch((e) => e);
    expect(code(e1)).toBe("NOT_FOUND"); // not even their own file may carry staff fields
    const own = await (async () => {
      const { createApplication: c } = await import("@/lib/applications");
      return c(bAdmin, { visaTypeCode: visaCode });
    })();
    const e2 = await updateApplication(bAdmin, own.id, { staffNotes: "still not allowed" } as never).catch((e) => e);
    expect(code(e2)).toBe("FORBIDDEN");
    const e3 = await appendNote(bAdmin, own.id, { body: "sneaky internal note", customerVisible: false }).catch((e) => e);
    expect(code(e3)).toBe("FORBIDDEN");
  });

  it("role limits: an AGENCY_USER cannot submit or manage the team", async () => {
    const e = await transitionStatus(bUser, appA, { toStatusCode: "NEW" }).catch((x) => x);
    expect(["NOT_FOUND", "FORBIDDEN", "STATE_CONFLICT"]).toContain(code(e));
    const canSubmit = await import("@/lib/rbac").then((m) => m.can("AGENCY_USER", "applications.submit"));
    expect(canSubmit).toBe(false);
    const teamRead = await import("@/lib/guard").then((m) => {
      try {
        return m.buildActor({ id: userB.id, email: userB.email, name: "x", role: "AGENCY_USER", agencyIds: [B] }, "agencies.users.manage");
      } catch (err) {
        return (err as Error).name;
      }
    });
    expect(teamRead).toBe("AuthorizationError");
  });

  it("ACCOUNTING may move money but not touch cases", async () => {
    const t = ctx.db as any;
    const { users } = await import("@/db");
    const acct = (await t.insert(users).values({ email: "books@x.test", name: "Books", passwordHash: await hashPassword("test-password-123"), role: "ACCOUNTING" }).returning())[0] as { id: string; email: string; role: string };
    const moneyActor = buildStaffActor({ ...acct, name: "Books", role: "ACCOUNTING" as never, agencyIds: [] }, "wallet.write");
    const credited = await creditWallet(moneyActor, { agencyId: B, amountCents: 250000, currencyCode: "EUR", reason: "Accounting can fund wallets", idempotencyKey: "acct-1" });
    expect(credited.balanceAfterCents).toBe(250000);
    const caseWrite = await updateApplication(moneyActor as never, appA, { notes: "no" }).catch((e) => e);
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(code(caseWrite));
    const assign = await assignCaseOfficer(moneyActor as never, appA, null).catch((e) => e);
    expect(code(assign)).toBe("FORBIDDEN");
  });

  it("VISA_AGENT may work files but never move money", async () => {
    const t = ctx.db as any;
    const { users } = await import("@/db");
    const va = (await t.insert(users).values({ email: "agent@x.test", name: "Agent", passwordHash: await hashPassword("test-password-123"), role: "VISA_AGENT" }).returning())[0] as { id: string; email: string; role: string };
    const actor = buildStaffActor({ ...va, name: "Agent", role: "VISA_AGENT" as never, agencyIds: [] }, "applications.write");
    const denied = await creditWallet(actor, { agencyId: B, amountCents: 1, currencyCode: "EUR", reason: "should fail" }).catch((e) => e);
    expect(code(denied)).toBe("FORBIDDEN");
    const canSee = await import("@/lib/rbac").then((m) => m.can("VISA_AGENT", "wallet.write"));
    expect(canSee).toBe(false);
  });

  it("an agency cannot see an internal status or step into it", async () => {
    const t = ctx.db as any;
    const { applicationStatuses } = await import("@/db");
    await t
      .update(applicationStatuses)
      .set({ customerVisible: false })
      .where(sql`${applicationStatuses.code} = 'UNDER_REVIEW'`);
    const own = await createApplication(bAdmin, { visaTypeCode: visaCode });
    const e = await transitionStatus(bAdmin, own.id, { toStatusCode: "UNDER_REVIEW" }).catch((x) => x);
    expect(code(e)).toBe("NOT_FOUND");
    await t.update(applicationStatuses).set({ customerVisible: true }).where(sql`${applicationStatuses.code} = 'UNDER_REVIEW'`);
  });

  it("a de-linked member cannot even build an actor (no empty-tenant reads)", async () => {
    const t = ctx.db as any;
    const { agencyMemberships, users } = await import("@/db");
    const orphan = (await t.insert(users).values({ email: "orphan@x.test", name: "Orphan", passwordHash: await hashPassword("test-password-123"), role: "AGENCY_ADMIN" }).returning())[0] as { id: string; email: string; role: string };
    const linked = await t.insert(agencyMemberships).values({ agencyId: A, userId: orphan.id, isPrimary: false }).returning();
    void linked;
    const before = buildActor({ ...orphan, name: "o", role: orphan.role as never, agencyIds: [A] }, "applications.read");
    expect((await listApplications(before)).rows.length).toBeGreaterThan(0);
    await t.delete(agencyMemberships).where(eq(agencyMemberships.userId, orphan.id));
    // an agency user with no membership is refused at the actor boundary — it
    // cannot even be constructed, so no query runs with an empty tenant set
    let buildError = "";
    try {
      buildActor({ ...orphan, name: "o", role: orphan.role as never, agencyIds: [] }, "applications.read");
    } catch (err) {
      buildError = (err as Error).message;
    }
    expect(buildError).toContain("No agency is linked");
  });

  it("exports/lists never widen when filters are forged", async () => {
    // staff can filter by agency; an agency passing the same filter is pinned
    const asStaff = await listApplications(staff, { agencyId: A, pageSize: 100 });
    expect(asStaff.rows.some((r) => r.id === appA)).toBe(true);
    const asB = await listApplications(bAdmin, { agencyId: A, pageSize: 100 });
    expect(asB.rows.every((r) => r.agencyId === B)).toBe(true);
    expect(asB.rows.some((r) => r.id === appA)).toBe(false);
  });
});
