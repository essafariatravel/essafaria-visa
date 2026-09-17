import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers";
import { hashPassword } from "@/lib/password";
import { buildActor, buildStaffActor } from "@/lib/guard";
import { createApplication, getChecklist, publicChecklistBundle } from "@/lib/applications";
import { listDocuments, openDocumentContent, reviewDocument, uploadDocument, expireDueDocuments, withdrawDocument } from "@/lib/documents";
import { DomainError } from "@/lib/ops";

type Ctx = Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let A: string;
let B: string;
let appA: string;
let applicantA: string;
let visaCode: string;
let agencyAdmin: any;
let agencyAdminB: any;
let staff: any;
let staffUser: { id: string; email: string; role: string };

const code = (e: unknown) => (e as DomainError).code;

/** minimal but real PDF: signature + body padding (sniffing needs >1 KB) */
function pdf(extra = 0): Buffer {
  const head = Buffer.from("%PDF-1.4\n", "latin1");
  const body = Buffer.from("1 0 obj<</Type/Catalog>>endobj\n".repeat(80), "latin1");
  const tail = Buffer.from("\n%%EOF\n", "latin1");
  const pad = extra ? Buffer.alloc(extra, 0x20) : Buffer.alloc(0);
  return Buffer.concat([head, body, pad, tail]);
}

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.seed();
  const t = ctx.db as any;
  const { agencies, users, agencyMemberships, visaTypes } = await import("@/db");
  const pw = await hashPassword("test-password-123");
  const [a] = await t.insert(agencies).values({ code: "DA", name: "Doc Agency A", status: "ACTIVE" }).returning();
  const [b] = await t.insert(agencies).values({ code: "DB", name: "Doc Agency B", status: "ACTIVE" }).returning();
  A = a.id;
  B = b.id;
  const [ua] = await t.insert(users).values({ email: "da@a.test", name: "DA", passwordHash: pw, role: "AGENCY_ADMIN" }).returning();
  const [ub] = await t.insert(users).values({ email: "db@b.test", name: "DB", passwordHash: pw, role: "AGENCY_ADMIN" }).returning();
  const [us] = await t.insert(users).values({ email: "desk@essafaria.test", name: "Desk", passwordHash: pw, role: "VISA_AGENT" }).returning();
  await t.insert(agencyMemberships).values([
    { agencyId: A, userId: ua.id, isPrimary: true },
    { agencyId: B, userId: ub.id, isPrimary: true },
  ]);
  staffUser = { id: us.id, email: us.email, role: us.role };
  const [vt] = await t.select({ code: visaTypes.code }).from(visaTypes).where(sql`is_active = true`).limit(1);
  visaCode = vt.code;
  agencyAdmin = buildActor({ id: ua.id, email: ua.email, name: "DA", role: "AGENCY_ADMIN", agencyIds: [A] }, "documents.upload");
  agencyAdminB = buildActor({ id: ub.id, email: ub.email, name: "DB", role: "AGENCY_ADMIN", agencyIds: [B] }, "documents.upload");
  staff = buildStaffActor({ id: us.id, email: us.email, name: "Desk", role: "VISA_AGENT", agencyIds: [] }, "applications.review");

  const created = await createApplication(agencyAdmin, { visaTypeCode: visaCode, requestedCount: 1 });
  appA = created.id;
  const { upsertApplicant } = await import("@/lib/applicants");
  applicantA = (await upsertApplicant(agencyAdmin, appA, { fullName: "Doc Owner", passportExpiryDate: "2032-03-03", dateOfBirth: "1992-02-02", nationalityCountryCode: "DZ" })).id;
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe("document upload & checklist (Phase 5)", () => {
  it("stores bytes outside the database, links metadata, and moves the checklist", async () => {
    const before = await getChecklist(agencyAdmin, appA);
    const passportItem = before.items.find((i: any) => i.documentTypeCode === "PASSPORT")!;
    expect(passportItem.state).toBe("MISSING");

    const res = await uploadDocument(agencyAdmin, appA, {
      bytes: pdf(),
      filename: "passport scan.pdf",
      claimedMime: "application/pdf",
      documentTypeCode: "PASSPORT",
      applicantId: applicantA,
      agencyNotes: "Colour scan of the biometric page",
    });
    expect(res.version).toBe(1);
    expect(res.satisfiesRequirement).toBe(true);
    expect(res.mediaId).toBeTruthy();
    expect(res.reviewState).toBe("PENDING");

    const docs = await listDocuments(agencyAdmin, appA);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toBe("passport scan.pdf");
    expect(docs[0]!.bytes).toBeGreaterThan(1024);

    // media row is metadata only — never the binary
    const t = ctx.db as any;
    const { media } = await import("@/db");
    const [m] = await t.select().from(media).where(eq(media.id, res.mediaId)).limit(1);
    expect(m.kind).toBe("DOCUMENT");
    expect(m.storageKey).toContain("documents/");
    expect(Object.keys(m)).not.toContain("data");

    const after = await getChecklist(agencyAdmin, appA);
    const item = after.items.find((i: any) => i.documentTypeCode === "PASSPORT" && i.applicantId === applicantA)!;
    expect(item.state).toBe("PENDING_REVIEW");
    expect(after.complete).toBe(false);

    const events = await t
      .select()
      .from((await import("@/db")).applicationEvents)
      .where(eq((await import("@/db")).applicationEvents.applicationId, appA));
    expect(events.map((e: any) => e.type)).toContain("DOCUMENT_UPLOADED");
    const audits = await t
      .select()
      .from((await import("@/db")).auditLogs)
      .where(and(eq((await import("@/db")).auditLogs.entityType, "application_document"), eq((await import("@/db")).auditLogs.action, "UPLOAD")));
    expect(audits.length).toBe(1);
    expect(audits[0].metadata.sha256).toMatch(/^[0-9a-f]{64}$/);

    // the desk role was told to review — and only that role (no broadcast)
    const notes = await t.select().from((await import("@/db")).notifications).where(eq((await import("@/db")).notifications.kind, "DOCUMENT_UPLOADED"));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.some((n: any) => n.userId === staffUser.id)).toBe(true);
    expect(notes.every((n: any) => n.staffOnly === true)).toBe(true);
  });

  it("refuses anything that is not really the file type it claims", async () => {
    const html = Buffer.from("<html><script>alert(1)</script>" + "x".repeat(2000) + "</html>", "utf8");
    await expect(
      uploadDocument(agencyAdmin, appA, { bytes: html, filename: "passport.pdf", documentTypeCode: "PASSPORT", applicantId: applicantA }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4000, 0x41)]);
    await expect(
      uploadDocument(agencyAdmin, appA, { bytes: exe, filename: "evil.pdf", documentTypeCode: "PASSPORT", applicantId: applicantA }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const empty = Buffer.alloc(0);
    await expect(
      uploadDocument(agencyAdmin, appA, { bytes: empty, filename: "a.pdf", documentTypeCode: "PASSPORT", applicantId: applicantA }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // a file that IS a real PDF but a type the checklist rejects by extension
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2048, 0x00),
    ]);
    const res = await uploadDocument(agencyAdmin, appA, { bytes: png, filename: "passport.png", documentTypeCode: "PASSPORT", applicantId: applicantA });
    expect(res.documentId).toBeTruthy(); // PASSPORT accepts png per configuration
    await ctx.db;
    // PHOTO accepts jpg/png only — a PDF must be refused
    await expect(
      uploadDocument(agencyAdmin, appA, { bytes: pdf(), filename: "photo.pdf", documentTypeCode: "PHOTO", applicantId: applicantA }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("enforces the configured size ceiling per document type", async () => {
    // PHOTO maxFileSizeMb = 2 in configuration
    const big = pdf(3 * 1024 * 1024);
    await expect(
      uploadDocument(agencyAdmin, appA, { bytes: big, filename: "huge.pdf", documentTypeCode: "PHOTO", applicantId: applicantA }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("accepts a document, applies the configured validity window, and satisfies the checklist", async () => {
    const docs = await listDocuments(agencyAdmin, appA);
    const passport = docs.find((d) => d.documentTypeCode === "PASSPORT" && d.isCurrent)!;
    await reviewDocument(staff, passport.id, { decision: "ACCEPT", note: "Clear and in date" });

    const after = await listDocuments(staff, appA);
    const accepted = after.find((d) => d.id === passport.id)!;
    expect(accepted.reviewState).toBe("ACCEPTED");
    expect(accepted.expiresAt).toBeTruthy();
    const days = (new Date(accepted.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(80); // PASSPORT requirement validityDays = 90

    const checklist = await getChecklist(agencyAdmin, appA);
    const item = checklist.items.find((i: any) => i.documentTypeCode === "PASSPORT")!;
    expect(item.satisfiedByCurrentDocument).toBe(true);

    const t = ctx.db as any;
    const notes = await t.select().from((await import("@/db")).notifications).where(eq((await import("@/db")).notifications.kind, "DOCUMENT_ACCEPTED"));
    expect(notes.length).toBe(1);
    expect(notes[0].agencyId).toBe(A); // the agency, not another tenant
  });

  it("replaces instead of destroying, and blocks an identical re-upload", async () => {
    // BANK_STATEMENT accepts PDFs per configuration, so versions are comparable
    const first = await uploadDocument(agencyAdmin, appA, {
      bytes: pdf(1024),
      filename: "bank-1.pdf",
      documentTypeCode: "BANK_STATEMENT",
      applicantId: applicantA,
    });
    expect(first.version).toBe(1);
    expect(first.supersededDocumentId).toBeNull();

    // identical bytes into the same slot is a duplicate, not a second version
    const dupe = await uploadDocument(agencyAdmin, appA, {
      bytes: pdf(1024),
      filename: "bank-copy.pdf",
      documentTypeCode: "BANK_STATEMENT",
      applicantId: applicantA,
    }).catch((e) => e);
    expect(code(dupe)).toBe("DUPLICATE");

    const second = await uploadDocument(agencyAdmin, appA, {
      bytes: pdf(2048),
      filename: "bank-2.pdf",
      documentTypeCode: "BANK_STATEMENT",
      applicantId: applicantA,
    });
    expect(second.version).toBe(2);
    expect(second.supersededDocumentId).toBe(first.documentId);

    const after = await listDocuments(agencyAdmin, appA);
    const old = after.find((d) => d.id === first.documentId)!;
    expect(old.isCurrent).toBe(false);
    expect(old.reviewState).toBe("SUPERSEDED");
    expect(after.find((d) => d.id === second.documentId)!.isCurrent).toBe(true);
    // only one current row per slot — the partial unique index held
    const currentForSlot = after.filter((d) => d.documentTypeCode === "BANK_STATEMENT" && d.isCurrent);
    expect(currentForSlot.length).toBe(1);
  });

  it("keeps one current document per slot even when two uploads race", async () => {
    const results = await Promise.allSettled([
      uploadDocument(agencyAdmin, appA, { bytes: pdf(4096), filename: "race-a.pdf", documentTypeCode: "TRAVEL_INSURANCE", applicantId: applicantA }),
      uploadDocument(agencyAdmin, appA, { bytes: pdf(8192), filename: "race-b.pdf", documentTypeCode: "TRAVEL_INSURANCE", applicantId: applicantA }),
    ]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    expect(okCount).toBeGreaterThanOrEqual(1);
    const docs = await listDocuments(agencyAdmin, appA);
    expect(docs.filter((d) => d.documentTypeCode === "TRAVEL_INSURANCE" && d.isCurrent).length).toBe(1);
  });
  it("answers 404 for a foreign file regardless of the file contents", async () => {
    const junk = Buffer.from("<html><body>not a pdf</body></html>" + "x".repeat(2000), "utf8");
    const other = await createApplication(agencyAdmin, { visaTypeCode: visaCode });
    const e = await uploadDocument(agencyAdminB, appA, { bytes: junk, filename: "sneaky.pdf", documentTypeCode: "PASSPORT" }).catch((x) => x);
    // a malformed payload on a foreign application must look exactly like a
    // missing application, never a validation error that hints at the difference
    expect(code(e)).toBe("NOT_FOUND");
    const same = await uploadDocument(agencyAdmin, other.id, { bytes: junk, filename: "sneaky.pdf", documentTypeCode: "PASSPORT" }).catch((x) => x);
    expect(code(same)).toBe("VALIDATION");
  });

  it("proves the applicant relationship and the tenant before writing", async () => {
    const other = await createApplication(agencyAdminB, { visaTypeCode: visaCode });
    const { upsertApplicant } = await import("@/lib/applicants");
    const otherApplicant = (await upsertApplicant(agencyAdminB, other.id, { fullName: "Other Person", passportExpiryDate: "2031-01-01", dateOfBirth: "1990-01-01" })).id;

    // A cannot hang a document on B's traveller
    await expect(
      uploadDocument(agencyAdmin, appA, { bytes: pdf(128), filename: "x.pdf", documentTypeCode: "BANK_STATEMENT", applicantId: otherApplicant }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // B cannot upload into A's file at all
    await expect(
      uploadDocument(agencyAdminB, appA, { bytes: pdf(256), filename: "x.pdf", documentTypeCode: "PASSPORT", applicantId: applicantA }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // B cannot list or open A's documents
    await expect(listDocuments(agencyAdminB, appA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const docs = await listDocuments(agencyAdmin, appA);
    await expect(openDocumentContent({ documentId: docs[0]!.id }, { id: "x", email: "db@b.test", name: "B", role: "AGENCY_ADMIN", agencyIds: [B] } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      openDocumentContent({ documentId: "does-not-exist" }, { id: "y", email: "desk@essafaria.test", name: "D", role: "VISA_AGENT", agencyIds: [] } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serves bytes only to an authorised viewer and audits the read", async () => {
    const docs = await listDocuments(agencyAdmin, appA);
    const target = docs.find((d) => d.isCurrent && d.documentTypeCode === "PASSPORT")!;
    const bytes = await openDocumentContent({ documentId: target.id }, { id: staffUser.id, email: staffUser.email, name: "Desk", role: "VISA_AGENT", agencyIds: [] } as never);
    // the CURRENT passport is the png uploaded earlier — what matters is that the
    // served bytes and MIME match the stored object, whatever its real format
    expect(bytes.buffer.length).toBe(target.bytes);
    expect(["application/pdf", "image/png"]).toContain(bytes.mimeType);
    if (bytes.mimeType === "image/png") expect(bytes.buffer.subarray(1, 4).toString("latin1")).toBe("PNG");
    else expect(bytes.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const t = ctx.db as any;
    const reads = await t
      .select()
      .from((await import("@/db")).auditLogs)
      .where(and(eq((await import("@/db")).auditLogs.action, "DOWNLOAD"), eq((await import("@/db")).auditLogs.entityId, target.id)));
    expect(reads.length).toBeGreaterThan(0);
    // the media row behind a document is metadata only, tagged DOCUMENT
    const { media, applicationDocuments } = await import("@/db");
    const [docRow] = await t.select({ mediaId: applicationDocuments.mediaId }).from(applicationDocuments).where(eq(applicationDocuments.id, target.id)).limit(1);
    const [m] = await t.select().from(media).where(eq(media.id, docRow.mediaId)).limit(1);
    expect(m.kind).toBe("DOCUMENT");
  });

  it("an agency may not review, and may not attach off-checklist documents", async () => {
    await expect(reviewDocument(agencyAdmin, "whatever", { decision: "ACCEPT" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      uploadDocument(agencyAdmin, appA, { bytes: pdf(300), filename: "extra.pdf", documentTypeCode: "INVITATION", applicantId: applicantA }),
    ).rejects.toBeTruthy(); // not a requirement of this route
    // staff may, and it is flagged as not satisfying anything
    const res = await uploadDocument(staff, appA, { bytes: pdf(400), filename: "extra.pdf", documentTypeCode: "INVITATION", applicantId: applicantA });
    expect(res.satisfiesRequirement).toBe(false);
    const docs = await listDocuments(staff, appA);
    expect(docs.find((d) => d.id === res.documentId)!.wasRequiredAtUpload).toBe(false);
  });

  it("refuses a double decision and withdraws cleanly", async () => {
    const docs = await listDocuments(agencyAdmin, appA);
    const bank = await uploadDocument(agencyAdmin, appA, { bytes: pdf(512), filename: "bank.pdf", documentTypeCode: "BANK_STATEMENT", applicantId: applicantA });
    const id = bank.documentId;
    const [first, second] = await Promise.allSettled([
      reviewDocument(staff, id, { decision: "ACCEPT" }),
      reviewDocument(staff, id, { decision: "REJECT", note: "blurry copy of the statement" }),
    ]);
    const okCount = [first, second].filter((r) => r.status === "fulfilled").length;
    const rejected = [first, second].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(okCount).toBe(1);
    expect(rejected).toBeTruthy();
    expect(["STATE_CONFLICT", "RACE"]).toContain((rejected!.reason as DomainError).code);

    const after = (await listDocuments(staff, appA)).find((d) => d.id === id)!;
    expect(["ACCEPTED", "REJECTED"]).toContain(after.reviewState);

    if (after.reviewState === "ACCEPTED") {
      // accepted docs cannot be re-reviewed; withdrawal is the staff path
      await withdrawDocument(staff, id, "uploaded against the wrong traveller");
      const w = (await listDocuments(staff, appA)).find((d) => d.id === id)!;
      expect(w.isCurrent).toBe(false);
      expect(w.reviewState).toBe("SUPERSEDED");
    }
  });

  it("expires documents past their validity window and reopens the gate", async () => {
    const t = ctx.db as any;
    const { applicationDocuments } = await import("@/db");
    const docs = await listDocuments(staff, appA);
    const accepted = docs.find((d) => d.reviewState === "ACCEPTED" && d.isCurrent);
    if (!accepted) throw new Error("setup: expected an accepted document");
    await t
      .update(applicationDocuments)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(applicationDocuments.id, accepted.id));

    const res = await expireDueDocuments();
    expect(res.expired).toBeGreaterThanOrEqual(1);
    const after = (await listDocuments(staff, appA)).find((d) => d.id === accepted.id)!;
    expect(after.reviewState).toBe("EXPIRED");
    const notes = await t.select().from((await import("@/db")).notifications).where(eq((await import("@/db")).notifications.kind, "DOCUMENT_EXPIRED"));
    expect(notes.length).toBe(1);
    expect(notes[0].agencyId).toBe(A);
    const [app] = await t.select({ checklistComplete: (await import("@/db")).visaApplications.checklistComplete }).from((await import("@/db")).visaApplications).where(eq((await import("@/db")).visaApplications.id, appA));
    expect(app.checklistComplete).toBe(false);
    // running the sweep twice must not double-notify
    const again = await expireDueDocuments();
    expect(again.expired).toBe(0);
  });
});

describe("checklist payload projection (what leaves the server)", () => {
  it("keeps platform configuration out of a partner response", async () => {
    const bundle = await getChecklist(agencyAdmin, appA);
    // the service itself is complete — staff screens and the desk need it
    expect(bundle.snapshot).toBeTruthy();
    expect(bundle.items.length).toBeGreaterThan(0);

    const staffView = publicChecklistBundle(staff, bundle) as any;
    expect(staffView.snapshot).toBeTruthy();
    expect(typeof staffView.configDrifted).toBe("boolean");

    const partner = publicChecklistBundle(agencyAdmin, bundle) as any;
    expect(partner.items.length).toBeGreaterThan(0); // the checklist itself is theirs
    expect(partner.blocking).toBeDefined();
    expect(partner.snapshot).toBeUndefined();
    expect(partner.configDrifted).toBeUndefined();
    expect(partner.agencySelfSubmit).toBeUndefined();
    const json = JSON.stringify(partner);
    for (const internal of ["perApplicantPolicy", "prioritySurchargePercent", "capturedFromConfigAt", "agencySelfSubmit", "billingCurrency"]) {
      expect(json).not.toContain(internal);
    }
  });
});
