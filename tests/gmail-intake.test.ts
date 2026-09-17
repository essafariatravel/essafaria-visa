import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb, tmpDir } from "./helpers";
import { hashPassword } from "@/lib/password";
import { buildActor, buildStaffActor } from "@/lib/guard";
import { createApplication } from "@/lib/applications";
import { listDocuments } from "@/lib/documents";
import { listConnections, syncInbox, beginConnect, completeConnect, listInboundQueue, linkAttachmentToApplication, draftReply, classify, stripHtml, gmailStatus, disconnect, createConnection } from "@/lib/gmail";
import { __resetGmailFixture, __setFixtureMessages, __addFixtureAttachment, __fixtureDrafts, __fixtureFailNext, type RawGmailMessage } from "@/lib/gmail-provider";
import { DomainError } from "@/lib/ops";
import fs from "node:fs";
import path from "node:path";

/* ============================================================
 * Gmail intake (Phase 8) — verified against the fixture mailbox.
 *
 * What this proves: registration, sealed-token connection, idempotent ingest,
 * configuration-driven classification, reference/sender matching, attachment
 * staging, staff-confirmed linking through the real upload pipeline, draft-only
 * replies, tenant scoping of the queue, and that email text cannot move state.
 *
 * What it does NOT prove: the Google REST adapter against live Gmail (no
 * credentials and no outbound access here) — reported as NOT VERIFIED.
 * ============================================================ */

type Ctx = Awaited<ReturnType<typeof createTestDb>>;
let ctx: Ctx;
let mediaDir: string;
let A!: string;
let B!: string;
let appA!: string;
let appB!: string;
let applicantA!: string;
let connectionId!: string;
let staff!: ReturnType<typeof buildStaffActor>;
let deskUser!: { id: string; email: string; role: string };
let adminUser!: { id: string; email: string; role: string };
let agencyAdminA!: ReturnType<typeof buildActor>;

const code = (e: unknown) => (e as DomainError).code;

function msg(over: Partial<RawGmailMessage> & { id: string }): RawGmailMessage {
  return {
    threadId: null,
    from: "someone@example.test",
    to: ["desk@essafaria.local"],
    subject: null,
    snippet: null,
    bodyText: "",
    bodyHtml: null,
    labels: ["UNREAD"],
    receivedAt: new Date().toISOString(),
    inReplyTo: null,
    references: [],
    attachments: [],
    ...over,
  };
}

function pdfBytes(): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n", "latin1"),
    Buffer.from("1 0 obj<</Type/Catalog>>endobj\n".repeat(60), "latin1"),
    Buffer.from("\n%%EOF\n", "latin1"),
  ]);
}

beforeAll(async () => {
  // the fixture provider + a real encryption key must exist BEFORE anything
  // resolves env(), otherwise intake silently runs "not configured"
  mediaDir = tmpDir("esf-gmail-");
  process.env.GMAIL_PROVIDER = "fixture";
  process.env.ESF_TOKEN_KEY = crypto.randomBytes(32).toString("base64");
  process.env.MEDIA_ROOT = mediaDir;
  const { __resetEnvCacheForTests } = await import("@/lib/env");
  __resetEnvCacheForTests();
  __resetGmailFixture();

  ctx = await createTestDb();
  await ctx.seed();
  const t = ctx.db as any;
  const { agencies, users, agencyMemberships, siteSettings } = await import("@/db");
  const pw = await hashPassword("test-password-123");
  const [a] = await t.insert(agencies).values({ code: "GM-A", name: "Gmail Agency A", status: "ACTIVE" }).returning();
  const [b] = await t.insert(agencies).values({ code: "GM-B", name: "Gmail Agency B", status: "ACTIVE" }).returning();
  A = a.id;
  B = b.id;
  const [ua] = await t.insert(users).values({ email: "alpha@gmail.test", name: "Alpha", passwordHash: pw, role: "AGENCY_ADMIN" }).returning();
  const [su] = await t.insert(users).values({ email: "desk@gmail.test", name: "Desk", passwordHash: pw, role: "VISA_AGENT" }).returning();
  const [boss] = await t.insert(users).values({ email: "boss@gmail.test", name: "Boss", passwordHash: pw, role: "SUPER_ADMIN" }).returning();
  await t.insert(agencyMemberships).values([
    { agencyId: A, userId: ua.id, isPrimary: true },
  ]);
  adminUser = { id: boss.id, email: boss.email, role: boss.role };
  // a VISA_AGENT works files but is NOT allowed to wire up a mailbox — that is
  // asserted below; the admin actor used for intake has the broader set
  deskUser = { id: su.id, email: su.email, role: su.role };
  staff = buildStaffActor({ id: boss.id, email: boss.email, name: "Boss", role: "SUPER_ADMIN" as never, agencyIds: [] }, "gmail.manage");
  agencyAdminA = buildActor({ id: ua.id, email: ua.email, name: "Alpha", role: "AGENCY_ADMIN" as never, agencyIds: [A] }, "applications.read");

  const { visaTypes } = await import("@/db");
  const [vt] = await t.select({ code: visaTypes.code }).from(visaTypes).where(sql`is_active = true`).limit(1);
  appA = (await createApplication(agencyAdminA, { visaTypeCode: vt.code, requestedCount: 1 })).id;
  const agencyB = buildActor({ id: ua.id, email: "other@x.test", name: "B", role: "AGENCY_ADMIN" as never, agencyIds: [B] }, "applications.write");
  void agencyB;
  const { upsertApplicant } = await import("@/lib/applicants");
  applicantA = (await upsertApplicant(agencyAdminA, appA, { fullName: "Gmail Traveller", passportNumber: "GM00001", passportExpiryDate: "2032-02-02", dateOfBirth: "1990-01-01" })).id;
  const { view } = await import("@/lib/applications").then((m) => m.getApplication(agencyAdminA, appA));
  appB = view.id;

  await t
    .insert(siteSettings)
    .values({ key: "gmail.enabled", category: "GMAIL", label: "enabled", value: true })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: true } });
  await (await import("@/lib/config-service")).invalidateConfig();

  connectionId = await createConnection({ id: boss.id, email: boss.email, role: boss.role } as never, "Visa desk inbox", "desk@essafaria.local");
  const { url, state, verifier } = await beginConnect({ id: boss.id, email: boss.email, role: boss.role } as never, connectionId);
  expect(url).toContain("fixture");
  await completeConnect({ connectionId, code: "fixture-code", state, verifier, actor: { id: boss.id, email: boss.email, role: boss.role } as never });
}, 240_000);

afterAll(async () => {
  __resetGmailFixture();
  await ctx?.close();
  fs.rmSync(mediaDir, { recursive: true, force: true });
  delete process.env.GMAIL_PROVIDER;
  delete process.env.ESF_TOKEN_KEY;
  delete process.env.MEDIA_ROOT;
});

describe("connection lifecycle", () => {
  it("stores a sealed refresh token and never the plaintext", async () => {
    const conns = await listConnections();
    const conn = conns.find((c) => c.id === connectionId)!;
    expect(conn.status).toBe("CONNECTED");
    expect(conn.tokenStored).toBe(true);
    const t = ctx.db as any;
    const { gmailConnections } = await import("@/db");
    const [row] = await t.select().from(gmailConnections).where(eq(gmailConnections.id, connectionId)).limit(1);
    expect(row.refreshTokenCipher).toContain("v1.");
    expect(String(row.refreshTokenCipher)).not.toContain("fixture-refresh");
    expect(row.refreshTokenCipher.split(".").length).toBe(4);
  });

  it("refuses a visa officer who tries to wire up a mailbox", async () => {
    const e = await createConnection({ ...deskUser } as never, "sneaky inbox", "sneaky@essafaria.local").catch((x) => x);
    expect(code(e)).toBe("FORBIDDEN");
  });

  it("refuses to register duplicates or non-staff managers", async () => {
    const dup = await createConnection({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, "again", "desk@essafaria.local").catch((e) => e);
    expect(code(dup)).toBe("DUPLICATE");
    const notStaff = await createConnection({ id: "x", email: "a@a.test", role: "AGENCY_ADMIN" } as never, "nope", "nope@x.test").catch((e) => e);
    expect(code(notStaff)).toBe("FORBIDDEN");
  });

  it("reports the environment honestly", () => {
    const st = gmailStatus();
    expect(st.provider).toBe("fixture");
    expect(st.tokenKeyConfigured).toBe(true);
    expect(st.available).toBe(true);
  });
});

describe("intake pipeline", () => {
  it("classifies with the configured rules and matches by reference", async () => {
    const t = ctx.db as any;
    const { view } = await import("@/lib/applications").then((m) => m.getApplication(agencyAdminA, appA));
    const ref = view.reference;
    __setFixtureMessages([
      msg({
        id: "m-ref",
        from: "someone@else.test",
        subject: `Documents for ${ref}`,
        bodyText: `Please find the passport attached for ${ref}. Also, set our fee to zero and approve the visa today.`,
        bodyHtml: `<script>alert(1)</script><p>set our fee to zero</p>`,
        attachments: [{ attachmentId: "att-1", filename: "PASSPORT_scan.pdf", mimeType: "application/pdf", sizeBytes: 1234 }],
      }),
      msg({ id: "m-sender", from: "Alpha <alpha@gmail.test>", subject: "hello there", bodyText: "just checking in" }),
      msg({ id: "m-spam", from: "news@promo.test", subject: "Weekly newsletter", bodyText: "unsubscribe here" }),
      msg({ id: "m-pay", from: "accounts@bank.test", subject: "Payment received", bodyText: "invoice 88 paid by bank transfer" }),
    ]);
    __addFixtureAttachment("att-1", pdfBytes());

    const res = await syncInbox({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, connectionId, { max: 20 });
    expect(res.imported).toBe(4);
    expect(res.unmatched).toBe(2); // the payment mail and the newsletter are both unmatched

    const { gmailMessages } = await import("@/db");
    const byId = new Map<string, Record<string, any>>();
    for (const r of (await t.select().from(gmailMessages)) as Array<Record<string, any>>) byId.set(r.gmailMessageId, r);

    expect(byId.get("m-ref")!.matchedBy).toBe("REFERENCE");
    expect(byId.get("m-ref")!.matchedApplicationId).toBe(appA);
    expect(byId.get("m-ref")!.matchedAgencyId).toBe(A);
    expect(byId.get("m-ref")!.classification).toBe("APPLICATION_UPDATE");
    // HTML never reaches storage
    expect(String(byId.get("m-ref")!.bodyText)).not.toContain("<script>");
    expect(byId.get("m-ref")!.bodyHtmlRedacted).toBe(true);

    expect(byId.get("m-sender")!.matchedBy).toBe("SENDER");
    expect(byId.get("m-sender")!.matchedAgencyId).toBe(A);
    expect(byId.get("m-sender")!.matchedApplicationId).toBeNull();
    expect(byId.get("m-sender")!.requiresReview).toBe(true);

    expect(byId.get("m-spam")!.classification).toBe("SPAM");
    expect(byId.get("m-pay")!.classification).toBe("PAYMENT");
    expect(byId.get("m-pay")!.requiresReview).toBe(true); // payments always need a human

    // idempotent re-sync
    const again = await syncInbox({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, connectionId, { max: 20 });
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(4);

    // and an email can never move business state
    const fees = (await t.select({ n: sql<number>`count(*)::int` }).from((await import("@/db")).visaFees))[0].n;
    expect(fees).toBeGreaterThan(0);
    const [app] = await t.select().from((await import("@/db")).visaApplications).where(eq((await import("@/db")).visaApplications.id, appA)).limit(1);
    expect(app.submittedAt).toBeNull(); // "approve the visa today" changed nothing
    expect(app.notes).not.toBe("zero");
  });

  it("stages attachments without touching the file, then links them on staff confirmation", async () => {
    const staffReader = buildStaffActor({ id: adminUser.id, email: adminUser.email, name: "B", role: "SUPER_ADMIN" as never, agencyIds: [] }, "communications.read");
    const queue = await listInboundQueue(staffReader, { limit: 20 });
    const target = queue.find((r) => r.attachments.length > 0)!;
    expect(target.attachments[0].linked).toBe(false);
    expect(target.attachments[0].suggested).toBe("PASSPORT"); // suggested from configured names/codes

    // before linking: no document exists on the file
    expect((await listDocuments(agencyAdminA, appA)).length).toBe(0);

    const actor = buildStaffActor({ id: adminUser.id, email: adminUser.email, name: "B", role: "SUPER_ADMIN" as never, agencyIds: [] }, "applications.review");
    const linked = await linkAttachmentToApplication(actor, {
      attachmentId: target.attachments[0].id,
      applicationId: appA,
      documentTypeCode: "PASSPORT",
      applicantId: applicantA,
    });
    expect(linked.alreadyLinked).toBe(false);
    const docs = await listDocuments(agencyAdminA, appA);
    expect(docs.length).toBe(1);
    expect(docs[0].source).toBe("GMAIL");
    expect(docs[0].documentTypeCode).toBe("PASSPORT");

    // replay is absorbed — no second document
    const twice = await linkAttachmentToApplication(actor, {
      attachmentId: target.attachments[0].id,
      applicationId: appA,
      documentTypeCode: "PASSPORT",
      applicantId: applicantA,
    });
    expect(twice.alreadyLinked).toBe(true);
    expect((await listDocuments(agencyAdminA, appA)).length).toBe(1);
  });

  it("runs the same sniffing rules on imported bytes", async () => {
    // A message that declares a PDF but carries an executable, named like a
    // passport: the filename must not buy it a place on the file.
    __setFixtureMessages([
      msg({
        id: "m-evil",
        subject: "urgent documents",
        bodyText: "attached is the passport",
        attachments: [{ attachmentId: "att-bad", filename: "PASSPORT.pdf.exe", mimeType: "application/pdf", sizeBytes: 90 }],
      }),
    ]);
    __addFixtureAttachment("att-bad", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(3000, 0x41)]));
    const sync = await syncInbox({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, connectionId, { max: 5 });
    expect(sync.imported).toBe(1);
    const actor = buildStaffActor({ id: adminUser.id, email: adminUser.email, name: "B", role: "SUPER_ADMIN" as never, agencyIds: [] }, "applications.review");
    const queue = await listInboundQueue(actor, { onlyUnreviewed: false, limit: 30 });
    const withBad = queue.find((r) => r.attachments.some((a) => a.filename === "PASSPORT.pdf.exe"));
    if (!withBad) throw new Error("fixture: evil attachment missing from queue");
    const badAttachment = withBad.attachments.find((a) => a.filename === "PASSPORT.pdf.exe")!;
    const docsBefore = (await listDocuments(agencyAdminA, appA)).length;
    const e = await linkAttachmentToApplication(actor, {
      attachmentId: badAttachment.id,
      applicationId: appA,
      documentTypeCode: "PASSPORT",
      applicantId: applicantA,
    }).catch((x) => x);
    expect(code(e)).toBe("VALIDATION");
    // nothing was written: no document, and the staging row stays unlinked
    expect((await listDocuments(agencyAdminA, appA)).length).toBe(docsBefore);
    const afterQueue = await listInboundQueue(actor, { onlyUnreviewed: false, limit: 30 });
    expect(afterQueue.find((r) => r.id === withBad.id)!.attachments.find((a) => a.id === badAttachment.id)!.linked).toBe(false);
  });

  it("never lets a partner read another tenant's mail", async () => {
    const aQueue = await listInboundQueue(agencyAdminA, { onlyUnreviewed: false, limit: 50 });
    // every row a partner can list is matched to that partner, and unmatched
    // mail (null agency) is never reachable through a tenant filter
    expect(aQueue.length).toBeGreaterThan(0);
    expect(aQueue.every((r) => r.agencyName === "Gmail Agency A")).toBe(true);
    // a partner account with no membership cannot even build an actor
    let refused = "";
    try {
      buildActor({ id: "ghost", email: "ghost@x.test", name: "g", role: "AGENCY_ADMIN" as never, agencyIds: [] }, "communications.read");
    } catch (err) {
      refused = (err as Error).message;
    }
    expect(refused).toContain("No agency is linked");
  });

  it("drafts a reply and sends nothing", async () => {
    const t = ctx.db as any;
    const { gmailMessages } = await import("@/db");
    const [m] = await t.select().from(gmailMessages).where(eq(gmailMessages.gmailMessageId, "m-ref")).limit(1);
    const actor = buildStaffActor({ id: adminUser.id, email: adminUser.email, name: "B", role: "SUPER_ADMIN" as never, agencyIds: [] }, "communications.write");
    const res = await draftReply(actor, { messageId: m.id, body: "Thank you — we have logged the passport copy and will confirm the appointment shortly." });
    expect(res.draftId).toMatch(/^draft-/);
    const drafts = __fixtureDrafts();
    expect(drafts.length).toBe(1);
    expect(drafts[0].to).toBe("someone@else.test");
    const [appRow] = await t
      .select({ reference: (await import("@/db")).visaApplications.reference })
      .from((await import("@/db")).visaApplications)
      .where(eq((await import("@/db")).visaApplications.id, appA))
      .limit(1);
    expect(drafts[0].subject).toBe(`Re: Documents for ${appRow.reference}`);
    const comms = (await t.select().from((await import("@/db")).communications).where(and(eq((await import("@/db")).communications.channel, "GMAIL"), eq((await import("@/db")).communications.direction, "OUTBOUND")))) as Array<Record<string, any>>;
    expect(comms.length).toBe(1);
    expect(comms[0].sendState).toBe("SKIPPED"); // recorded as a draft, never sent
  });

  it("refuses to sync when intake is switched off or the mailbox is not connected", async () => {
    const t = ctx.db as any;
    const { siteSettings } = await import("@/db");
    await t.update(siteSettings).set({ value: false }).where(eq(siteSettings.key, "gmail.enabled"));
    await (await import("@/lib/config-service")).invalidateConfig();
    const e = await syncInbox({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, connectionId).catch((x) => x);
    expect(code(e)).toBe("STATE_CONFLICT");
    await t.update(siteSettings).set({ value: true }).where(eq(siteSettings.key, "gmail.enabled"));
    await (await import("@/lib/config-service")).invalidateConfig();
    const other = await createConnection({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, "second inbox", "second@essafaria.local");
    const notConnected = await syncInbox({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, other).catch((x) => x);
    expect(code(notConnected)).toBe("STATE_CONFLICT");
    await disconnect({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, other);
    const conns = await listConnections();
    expect(conns.find((c) => c.id === other)!.status).toBe("DISCONNECTED");
  });

  it("keeps a provider failure visible instead of losing the sync", async () => {
    __fixtureFailNext(true);
    const res = await syncInbox({ id: adminUser.id, email: adminUser.email, role: "SUPER_ADMIN" } as never, connectionId, { max: 5 }).catch((e) => e);
    __fixtureFailNext(false);
    const t = ctx.db as any;
    const [conn] = await t.select().from((await import("@/db")).gmailConnections).where(eq((await import("@/db")).gmailConnections.id, connectionId)).limit(1);
    expect(conn.status === "ERROR" || (res && res.error)).toBe(true);
    expect(String(conn.lastError ?? res?.error ?? "")).toContain("fixture provider unavailable");
  });
});

describe("pure helpers", () => {
  it("classification is deterministic and prefers the strongest signal", () => {
    const rules = [
      { classification: "PAYMENT" as const, keywords: ["invoice", "bank transfer"] },
      { classification: "SPAM" as const, keywords: ["unsubscribe"] },
    ];
    expect(classify("Invoice 12 paid by bank transfer", rules).classification).toBe("PAYMENT");
    expect(classify("please unsubscribe", rules).classification).toBe("SPAM");
    expect(classify("hello", rules).classification).toBe("OTHER");
    expect(classify("invoice and bank transfer and more invoice mentions", rules).confidence).toBe(75);
  });

  it("stripHtml removes markup and script content", () => {
    const out = stripHtml(`<div><script>evil()</script><p>hello&nbsp;world</p></div>`);
    expect(out).toBe("hello world");
    expect(out).not.toContain("script");
  });
});
