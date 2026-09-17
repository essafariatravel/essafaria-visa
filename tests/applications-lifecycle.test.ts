import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers";
import { hashPassword } from "@/lib/password";
import { buildActor } from "@/lib/guard";
import { createApplication, getApplication, listApplications, transitionStatus, getChecklist, appendNote } from "@/lib/applications";
import { DomainError } from "@/lib/ops";
import { ensureInvoiceForApplication, chargeApplication, creditWallet, getWallet, reconcileWallets } from "@/lib/billing";

type Ctx = Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let agencyA: string;
let agencyB: string;
let userIdA: string;
let userIdB: string;
let visaTypeCode: string;
let staff: ReturnType<typeof buildActor>;
let agencyAdminA: ReturnType<typeof buildActor>;
let agencyUserB: ReturnType<typeof buildActor>;

async function actorFor(user: { id: string; email: string; role: string }, agencyIds: string[]) {
  return buildActor(
    { id: user.id, email: user.email, name: user.id, role: user.role as never, agencyIds },
    "applications.write",
  );
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.seed();
  const { db } = ctx;
  const t = db as any;

  const [fr] = await t.select().from((await import("@/db")).countries).where(sql`code = 'FR'`).limit(1);
  const [agA] = await t
    .insert((await import("@/db")).agencies)
    .values({ code: "AGENCY-A", name: "Agency A", status: "ACTIVE", countryId: fr.id, walletBalanceCents: 0 })
    .returning();
  const [agB] = await t
    .insert((await import("@/db")).agencies)
    .values({ code: "AGENCY-B", name: "Agency B", status: "ACTIVE", countryId: fr.id, walletBalanceCents: 0 })
    .returning();
  agencyA = agA.id;
  agencyB = agB.id;

  const pw = await hashPassword("test-password-123");
  const [uA] = await t
    .insert((await import("@/db")).users)
    .values({ email: "a@a.test", name: "A Admin", passwordHash: pw, role: "AGENCY_ADMIN", isActive: true })
    .returning();
  const [uB] = await t
    .insert((await import("@/db")).users)
    .values({ email: "b@b.test", name: "B User", passwordHash: pw, role: "AGENCY_USER", isActive: true })
    .returning();
  const [uStaff] = await t
    .insert((await import("@/db")).users)
    .values({ email: "ops@essafaria.test", name: "Ops", passwordHash: pw, role: "SUPER_ADMIN", isActive: true })
    .returning();
  userIdA = uA.id;
  userIdB = uB.id;
  await t.insert((await import("@/db")).agencyMemberships).values([
    { agencyId: agencyA, userId: uA.id, isPrimary: true },
    { agencyId: agencyB, userId: uB.id, isPrimary: true },
  ]);

  const [vt] = await t.select().from((await import("@/db")).visaTypes).where(sql`is_active = true`).limit(1);
  visaTypeCode = vt.code;

  staff = buildActor(
    { id: uStaff.id, email: uStaff.email, name: "Ops", role: "SUPER_ADMIN" as never, agencyIds: [] },
    "applications.write",
    { onBehalfOfAgencyId: agencyA },
  );
  agencyAdminA = await actorFor(uA, [agencyA]);
  agencyUserB = await actorFor(uB, [agencyB]);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

const code = (e: unknown) => (e as DomainError).code;
const name = (e: unknown) => (e as Error).name;

describe("application lifecycle (Phase 3)", () => {
  it("creates a file with a unique reference, snapshot and audit trail", async () => {
    const created = await createApplication(agencyAdminA, { visaTypeCode, requestedCount: 2, notes: "Tourism for two" });
    expect(created.reference).toMatch(/^ESF-\d{4}-\d{6}$/);

    const { view } = await getApplication(agencyAdminA, created.id);
    expect(view.visaTypeCode).toBe(visaTypeCode);
    expect(view.statusCode).toBe("NEW");
    expect(view.applicantCount).toBe(0);
    expect(view.checklistComplete).toBe(false);

    // snapshot frozen with the configured requirement set (never hardcoded)
    const checklist = await getChecklist(agencyAdminA, created.id);
    expect(checklist.snapshot).not.toBeNull();
    expect(checklist.snapshot!.requirements.length).toBeGreaterThan(0);
    const requiredDefs = checklist.snapshot!.requirements.filter((r: any) => r.isRequired);
    // with no applicants yet, each requirement is one open slot
    expect(checklist.requiredTotal).toBe(requiredDefs.length);
    expect(checklist.complete).toBe(false);

    // once applicants exist, applicant-level documents are required PER APPLICANT
    // (ops.perApplicantDocumentPolicy = ALL) — the checklist is derived, not stored
    const { applicants: appt } = await import("@/db");
    await (ctx.db as any).insert(appt).values([
      { applicationId: created.id, agencyId: agencyA, fullName: "One Traveler" },
      { applicationId: created.id, agencyId: agencyA, fullName: "Two Traveler" },
    ]);
    const withTwo = await getChecklist(agencyAdminA, created.id);
    expect(withTwo.requiredTotal).toBe(requiredDefs.length * 2);
    expect(withTwo.blocking.length).toBe(requiredDefs.length * 2);

    const audits = await (ctx.db as any)
      .select()
      .from((await import("@/db")).auditLogs)
      .where(and(eq((await import("@/db")).auditLogs.entityType, "visa_application"), eq((await import("@/db")).auditLogs.entityId, created.id)));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.some((a: any) => a.action === "CREATE")).toBe(true);

    const events = await (ctx.db as any)
      .select()
      .from((await import("@/db")).applicationEvents)
      .where(eq((await import("@/db")).applicationEvents.applicationId, created.id));
    expect(events.map((e: any) => e.type)).toContain("APPLICATION_CREATED");

    // second file gets a different reference
    const second = await createApplication(agencyAdminA, { visaTypeCode, requestedCount: 1 });
    expect(second.reference).not.toBe(created.reference);
  });

  it("refuses unknown visa types and cross-tenant agency ids", async () => {
    await expect(createApplication(agencyAdminA, { visaTypeCode: "NOPE_NOT_REAL" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    // an agency asking to create on behalf of another agency is pinned to its own
    const forged = buildActor(
      { id: userIdA, email: "a@a.test", name: "A", role: "AGENCY_ADMIN" as never, agencyIds: [agencyA] },
      "applications.write",
      { onBehalfOfAgencyId: agencyB },
    );
    const created = await createApplication(forged, { visaTypeCode });
    const { view } = await getApplication(agencyAdminA, created.id);
    expect(view.agencyId).toBe(agencyA); // NOT agencyB
  });

  it("hides other tenants' files as NOT_FOUND (no existence oracle)", async () => {
    const created = await createApplication(agencyAdminA, { visaTypeCode });
    await expect(getApplication(agencyUserB, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // and the list is scoped
    const listB = await listApplications(agencyUserB);
    expect(listB.rows.some((r) => r.id === created.id)).toBe(false);
    const listA = await listApplications(agencyAdminA);
    expect(listA.rows.some((r) => r.id === created.id)).toBe(true);
  });

  it("moves status only along the configured graph and refuses illegal jumps", async () => {
    const created = await createApplication(agencyAdminA, { visaTypeCode });
    // legal: NEW → DOCUMENTS_REQUIRED
    const ok = await transitionStatus(agencyAdminA, created.id, { toStatusCode: "DOCUMENTS_REQUIRED" });
    expect(ok.toStatusCode).toBe("DOCUMENTS_REQUIRED");

    // illegal: DOCUMENTS_REQUIRED → COMPLETED is not in the configured graph
    await expect(transitionStatus(agencyAdminA, created.id, { toStatusCode: "COMPLETED" })).rejects.toMatchObject({
      code: "STATE_CONFLICT",
    });
    // same-status transition
    await expect(
      transitionStatus(agencyAdminA, created.id, { toStatusCode: "DOCUMENTS_REQUIRED" }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("enforces the submission gate, and records a mandatory override reason", async () => {
    const created = await createApplication(agencyAdminA, { visaTypeCode, requestedCount: 1 });
    await transitionStatus(staff, created.id, { toStatusCode: "DOCUMENTS_RECEIVED" });
    await transitionStatus(staff, created.id, { toStatusCode: "UNDER_REVIEW" });
    await transitionStatus(staff, created.id, { toStatusCode: "READY_FOR_SUBMISSION" });

    // SUBMITTED requires a complete checklist (configuration) → gate blocks
    const blocked = await transitionStatus(staff, created.id, { toStatusCode: "SUBMITTED" }).catch((e) => e);
    expect(code(blocked)).toBe("GATE_FAILED");

    // override without a reason → rejected
    const noReason = await transitionStatus(staff, created.id, {
      toStatusCode: "SUBMITTED",
      forceOverride: true,
    }).catch((e) => e);
    expect(code(noReason)).toBe("VALIDATION");

    // override with a proper reason → allowed, flagged permanently, audited
    const done = await transitionStatus(staff, created.id, {
      toStatusCode: "SUBMITTED",
      forceOverride: true,
      reason: "Consulate accepted the file with a partial set; missing bank letter promised by Friday.",
    });
    expect(done.overrodeGate).toBe(true);
    const { view } = await getApplication(staff, created.id);
    expect(view.gateOverridden).toBe(true);
    expect(view.statusCode).toBe("SUBMITTED");

    const audits = await (ctx.db as any)
      .select()
      .from((await import("@/db")).auditLogs)
      .where(and(eq((await import("@/db")).auditLogs.entityType, "visa_application"), eq((await import("@/db")).auditLogs.entityId, created.id)));
    expect(audits.some((a: any) => a.action === "OVERRIDE")).toBe(true);
  });

  it("writes a transactional outbox notification for every status change", async () => {
    const created = await createApplication(agencyAdminA, { visaTypeCode });
    await transitionStatus(agencyAdminA, created.id, { toStatusCode: "DOCUMENTS_REQUIRED", reason: "Need passport scan" });
    const rows = await (ctx.db as any)
      .select()
      .from((await import("@/db")).notifications)
      .where(eq((await import("@/db")).notifications.applicationId, created.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.userId === userIdA)).toBe(true); // tenant-correct recipient
    expect(rows.some((r: any) => r.kind === "STATUS_CHANGED")).toBe(true);
  });

  it("appends internal notes for staff and agency-visible notes separately", async () => {
    const created = await createApplication(agencyAdminA, { visaTypeCode });
    await appendNote(staff, created.id, { body: "Internal: verify sponsor letter with the consulate.", customerVisible: false });
    await appendNote(staff, created.id, { body: "Please upload the missing passport copy.", customerVisible: true });

    const staffView = await getApplication(staff, created.id);
    const agencyView = await getApplication(agencyAdminA, created.id);
    const { listTimeline } = await import("@/lib/applications");
    const staffTl = await listTimeline(staff, created.id);
    const agencyTl = await listTimeline(agencyAdminA, created.id, { customerView: true });
    expect(staffTl.filter((e) => e.type === "NOTE_INTERNAL").length).toBe(1);
    expect(agencyTl.some((e) => e.type === "NOTE_INTERNAL")).toBe(false);
    expect(agencyTl.some((e) => e.type === "NOTE_AGENCY")).toBe(true);
    expect(staffView.view).toHaveProperty("staffNotes");
    expect(agencyView.view).not.toHaveProperty("staffNotes");
  });

  it("builds a bill from the snapshot and charges the wallet atomically", async () => {
    const created = await createApplication(staff, { visaTypeCode, requestedCount: 3 });
    await transitionStatus(staff, created.id, { toStatusCode: "DOCUMENTS_RECEIVED" });
    await transitionStatus(staff, created.id, { toStatusCode: "UNDER_REVIEW" });
    await transitionStatus(staff, created.id, { toStatusCode: "READY_FOR_SUBMISSION" });
    await transitionStatus(staff, created.id, {
      toStatusCode: "SUBMITTED",
      forceOverride: true,
      reason: "Partial document set accepted by the consulate for this submission window.",
    });

    // submitting the file already raised the invoice (the status is configured to
    // bill at that point); asking again must return the SAME invoice, never a
    // second one for the same file
    const inv = await ensureInvoiceForApplication(created.id, undefined, { actor: staff });
    expect(inv.subtotalCents).toBeGreaterThan(0);
    const idem = await ensureInvoiceForApplication(created.id);
    expect(idem.invoiceId).toBe(inv.invoiceId);
    expect(idem.created).toBe(false);

    // insufficient funds first, then credit, then charge — all through the wallet
    const poor = await chargeApplication(staff, created.id).catch((e) => e);
    expect(code(poor)).toBe("INSUFFICIENT_FUNDS");

    const credit = await creditWallet(staff, {
      agencyId: agencyA,
      amountCents: inv.subtotalCents + 5000,
      currencyCode: "EUR",
      reason: "Bank transfer received 2026-09-16",
      reference: "BNK-001",
      idempotencyKey: "topup-001",
    });
    expect(credit.balanceAfterCents).toBe(inv.subtotalCents + 5000);

    // replaying the credit with the same idempotency key must not double-fund
    const replay = await creditWallet(staff, {
      agencyId: agencyA,
      amountCents: inv.subtotalCents + 5000,
      currencyCode: "EUR",
      reason: "Bank transfer received 2026-09-16 (retry)",
      idempotencyKey: "topup-001",
    });
    expect(replay.deduped).toBe(true);
    const walletAfterReplay = await getWallet(agencyA);
    expect(walletAfterReplay.balanceCents).toBe(credit.balanceAfterCents);

    const charged = await chargeApplication(staff, created.id);
    expect(charged.chargedCents).toBe(inv.subtotalCents);
    expect(charged.balanceAfterCents).toBe(5000);

    // double charge attempt → nothing more is taken
    const again = await chargeApplication(staff, created.id);
    expect(again.chargedCents).toBe(0);
    expect(again.alreadyCharged).toBe(true);
    const walletFinal = await getWallet(agencyA);
    expect(walletFinal.balanceCents).toBe(5000);

    // ledger integrity
    const rec = await reconcileWallets();
    const a = rec.find((r) => r.agencyId === agencyA)!;
    expect(a.consistent).toBe(true);
    expect(a.balanceCents).toBe(a.ledgerSumCents);
  });

  it("rejects writes from an agency that does not own the file", async () => {
    const created = await createApplication(agencyAdminA, { visaTypeCode });
    await expect(transitionStatus(agencyUserB, created.id, { toStatusCode: "NEW" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(appendNote(agencyUserB, created.id, { body: "should never land", customerVisible: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(ensureInvoiceForApplication("not-a-real-id")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("configuration-first + historical integrity (Phase 3 gate)", () => {
  it("repricing a visa type does not reprice an existing file, but does price a new one", async () => {
    const { saveEntity } = await import("@/lib/crud");
    const { visaFees, visaTypes } = await import("@/db");
    const [vt] = await (ctx.db as any)
      .select({ id: visaTypes.id, code: visaTypes.code })
      .from(visaTypes)
      .where(sql`is_active = true`)
      .limit(1);

    const created = await createApplication(staff, { visaTypeCode: vt.code, requestedCount: 1, agencyId: agencyA });
    const { getChecklist } = await import("@/lib/applications");
    const before = await getChecklist(staff, created.id);
    const beforeTotal = before.snapshot!.totalAmountCents;
    expect(beforeTotal).toBeGreaterThan(0);

    // the old invoice is issued from the snapshot
    const inv = await ensureInvoiceForApplication(created.id, undefined, { actor: staff });
    expect(inv.subtotalCents).toBe(beforeTotal);

    // an admin reprices the route through the ordinary configuration path
    const [fee] = await (ctx.db as any)
      .select()
      .from(visaFees)
      .where(and(eq(visaFees.visaTypeId, vt.id), eq(visaFees.feeType, "SERVICE_FEE")))
      .limit(1);
    const newAmount = Number(fee.amountCents) + 12345;
    await saveEntity(
      { id: staff.id, email: staff.email, role: "SUPER_ADMIN" as never },
      "fees",
      {
        visaTypeId: vt.id,
        currencyCode: fee.currencyCode,
        feeType: fee.feeType,
        amountCents: String(newAmount),
        effectiveFrom: "2020-01-01",
        isActive: true,
        notes: "repriced by test",
      },
      fee.id,
    );

    // existing file: snapshot + invoice are untouched
    const after = await getChecklist(staff, created.id);
    expect(after.snapshot!.totalAmountCents).toBe(beforeTotal);
    const invAfter = await ensureInvoiceForApplication(created.id);
    expect(invAfter.subtotalCents).toBe(beforeTotal);

    // a NEW file priced after the change carries the new price
    const second = await createApplication(staff, { visaTypeCode: vt.code, requestedCount: 1, agencyId: agencyA });
    const secondSnap = await getChecklist(staff, second.id);
    expect(secondSnap.snapshot!.totalAmountCents).toBe(beforeTotal + 12345);

    // and the configuration change is audited
    const audits = await (ctx.db as any)
      .select()
      .from((await import("@/db")).auditLogs)
      .where(and(eq((await import("@/db")).auditLogs.entityType, "visa_fee"), eq((await import("@/db")).auditLogs.entityId, fee.id)));
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe("UPDATE");
  });

  it("mints unique references when two submissions race", async () => {
    const [a, b] = await Promise.all([
      createApplication(staff, { visaTypeCode: visaTypeCode, requestedCount: 1, agencyId: agencyA }),
      createApplication(staff, { visaTypeCode: visaTypeCode, requestedCount: 1, agencyId: agencyA }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(a.reference).not.toBe(b.reference);
    const rows = await (ctx.db as any)
      .select({ n: sql`count(*)::int` })
      .from((await import("@/db")).visaApplications);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);
    const dup = await (ctx.db as any)
      .select({ n: sql`count(*)::int` })
      .from((await import("@/db")).visaApplications)
      .groupBy(sql`reference`)
      .orderBy(sql`count(*) desc`)
      .limit(1);
    expect(Number(dup[0]?.n ?? 1)).toBe(1); // no duplicated reference anywhere
  });

  it("refuses to nest transactions instead of silently escaping the atomic unit", async () => {
    const { withTx } = await import("@/lib/with-tx");
    await expect(
      withTx(async () => {
        await createApplication(staff, { visaTypeCode: visaTypeCode, agencyId: agencyA });
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});
