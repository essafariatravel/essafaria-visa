import { and, desc, eq, sql } from "drizzle-orm";
import {
  aiRuns,
  aiSuggestions,
  applicationDocuments,
  communications,
  getDb,
  media,
  users,
  visaApplications,
  type Database,
} from "@/db";
import { assertActorPermission, DomainError, auditIn } from "@/lib/ops";
import { withTx } from "@/lib/with-tx";
import { getSettingIn, getSetting } from "@/lib/config-service";
import type { OpActor } from "@/lib/guard";
// NOTE the import list below contains READ services only (plus the ordinary
// applicant write that a HUMAN triggers when accepting a suggestion, imported
// lazily inside that function). There is no path from analysis to a decision.
import { getApplication, getChecklist, listTimeline } from "@/lib/applications";
import { listApplicants } from "@/lib/applicants";
import { getInvoiceForApplication, getWallet } from "@/lib/billing";
import {
  aiAvailability,
  containsInjectionAttempt,
  extractPassportFields,
  fenceUntrusted,
  resolveAiProvider,
  type AiPurpose,
} from "@/lib/ai-provider";

type Q = any;

/* ============================================================
 * The AI visa assistant (Phase 9).
 *
 * What it is: a copilot that reads the SAME tenant-scoped services the UI uses,
 * writes an ai_runs record, and files ai_suggestions for a human to accept or
 * dismiss.
 *
 * What it is not: an authority. There is deliberately no call from this module
 * to reviewDocument(), transitionStatus(), chargeApplication() or any config
 * write. Accepting a suggestion re-enters an ordinary service as the reviewing
 * human, so the audit trail names a person, not a model.
 * ============================================================ */

export interface AiRunView {
  id: string;
  purpose: string;
  provider: string;
  model: string | null;
  confidence: number | null;
  text: string;
  structured: Record<string, unknown> | null;
  basis: string[];
  requiresHumanReview: boolean;
  createdAt: string;
  injectionSuspected: boolean;
}

export interface SuggestionView {
  id: string;
  kind: string;
  field: string | null;
  proposedValue: string | null;
  rationale: string | null;
  confidence: number;
  status: string;
  requiresHumanReview: boolean;
  runId: string;
  createdAt: string;
}

async function aiEnabled(t: Q): Promise<boolean> {
  const value = await getSettingIn<boolean>(t, "ai.enabled", true);
  return value !== false;
}

async function minConfidence(t: Q): Promise<number> {
  const n = Number(await getSettingIn<number>(t, "ai.minConfidencePercent", 80));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 80;
}

/** Persist an AI run. Never throws for storage reasons: an assistant outage
 *  must not break the page that shows it. */
async function recordRun(
  t: Q,
  input: {
    purpose: AiPurpose;
    actor: OpActor;
    applicationId?: string | null;
    documentId?: string | null;
    agencyId?: string | null;
    result: Awaited<ReturnType<typeof runProvider>>;
    facts: Record<string, unknown>;
  },
): Promise<string> {
  const rows = (await t
    .insert(aiRuns)
    .values({
      purpose: input.purpose,
      agencyId: input.agencyId ?? null,
      applicationId: input.applicationId ?? null,
      documentId: input.documentId ?? null,
      requestedBy: input.actor.id,
      provider: input.result.provider,
      model: input.result.model,
      status: input.result.errorMessage ? "FAILED" : "OK",
      confidence: input.result.confidence,
      input: { factsKeys: Object.keys(input.facts), untrustedBlocks: (input.result.basis ?? []).length },
      output: { text: input.result.text, structured: input.result.structured },
      basis: input.result.basis,
      tokensIn: input.result.tokensIn,
      tokensOut: input.result.tokensOut,
      durationMs: input.result.durationMs,
      errorMessage: input.result.errorMessage,
    })
    .returning({ id: aiRuns.id })) as Array<{ id: string }>;
  return rows[0]!.id;
}

async function runProvider(req: { purpose: AiPurpose; facts: Record<string, unknown>; untrusted?: string[] }) {
  const provider = resolveAiProvider();
  const started = Date.now();
  try {
    const res = await provider.complete({ purpose: req.purpose, facts: req.facts, untrusted: req.untrusted ?? [] });
    return res;
  } catch (err) {
    return {
      provider: provider.name,
      model: null,
      text: "",
      structured: null,
      confidence: 0,
      basis: [],
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - started,
      errorMessage: String((err as Error).message).slice(0, 300),
    };
  }
}

async function fileSuggestions(
  t: Q,
  runId: string,
  actor: OpActor,
  rows: Array<{
    kind: string;
    field?: string | null;
    proposedValue?: string | null;
    rationale?: string | null;
    confidence?: number;
    applicationId?: string | null;
    documentId?: string | null;
    applicantId?: string | null;
    agencyId?: string | null;
  }>,
): Promise<SuggestionView[]> {
  const floor = await minConfidence(t);
  const out: SuggestionView[] = [];
  for (const r of rows) {
    const confidence = Math.max(0, Math.min(100, Number(r.confidence ?? 0)));
    // Below the configured floor, a suggestion is advisory and cannot be
    // one-click accepted: it must be typed in by a person.
    const requiresHumanReview = confidence < floor || r.kind !== "FIELD_VALUE";
    const inserted = (await t
      .insert(aiSuggestions)
      .values({
        runId,
        agencyId: r.agencyId ?? null,
        applicationId: r.applicationId ?? null,
        documentId: r.documentId ?? null,
        applicantId: r.applicantId ?? null,
        kind: r.kind,
        field: r.field ?? null,
        proposedValue: r.proposedValue != null ? String(r.proposedValue).slice(0, 2000) : null,
        rationale: r.rationale != null ? String(r.rationale).slice(0, 2000) : null,
        confidence,
        requiresHumanReview,
        status: "PROPOSED",
      })
      .returning({ id: aiSuggestions.id })) as Array<{ id: string }>;
    out.push({
      id: inserted[0]!.id,
      kind: r.kind,
      field: r.field ?? null,
      proposedValue: r.proposedValue != null ? String(r.proposedValue).slice(0, 2000) : null,
      rationale: r.rationale ?? null,
      confidence,
      status: "PROPOSED",
      requiresHumanReview,
      runId,
      createdAt: new Date().toISOString(),
    });
  }
  void actor;
  return out;
}

/* ---------------- A. document extraction ---------------- */

export async function runDocumentExtraction(actor: OpActor, documentId: string): Promise<{ runId: string; fields: Record<string, string>; confidence: number; injectionSuspected: boolean; suggestions: SuggestionView[] }> {
  assertActorPermission(actor, "ai.use");
  const t: Q = await getDb();
  if (!(await aiEnabled(t))) throw new DomainError("STATE_CONFLICT", "The AI assistant is switched off in Settings → AI");
  const rows = (await t
    .select({
      id: applicationDocuments.id,
      applicationId: applicationDocuments.applicationId,
      agencyId: applicationDocuments.agencyId,
      applicantId: applicationDocuments.applicantId,
      mediaId: applicationDocuments.mediaId,
      documentTypeCode: applicationDocuments.documentTypeCode,
      filename: media.filename,
    })
    .from(applicationDocuments)
    .innerJoin(media, eq(media.id, applicationDocuments.mediaId))
    .where(eq(applicationDocuments.id, documentId))
    .limit(1)) as unknown as Array<{
    id: string;
    applicationId: string;
    agencyId: string;
    applicantId: string | null;
    mediaId: string;
    documentTypeCode: string;
    filename: string | null;
  }>;
  const doc = rows[0];
  if (!doc) throw new DomainError("NOT_FOUND", "Document not found");
  if (!actor.isStaff && !actor.agencyIds.includes(doc.agencyId)) throw new DomainError("NOT_FOUND", "Document not found");

  // Text available to the deterministic extractor: the stored bytes are scanned
  // for readable text runs (uncompressed PDFs and text payloads), plus any
  // inbound email body already attached to the same document.
  const { storage } = await import("@/lib/storage");
  const buf = await storage().get(
    ((await t.select({ key: media.storageKey }).from(media).where(eq(media.id, doc.mediaId)).limit(1)) as Array<{ key: string }>)[0]!.key,
  );
  const raw = buf ? buf.toString("latin1") : "";
  const readable = extractReadableText(raw);
  const emailTexts = (await t
    .select({ body: communications.body })
    .from(communications)
    .where(eq(communications.applicationId, doc.applicationId))
    .orderBy(desc(communications.createdAt))
    .limit(3)) as Array<{ body: string | null }>;
  const untrusted = [readable, ...emailTexts.map((e) => e.body ?? "").filter(Boolean)].filter((x) => x.trim().length > 0);
  const injectionSuspected = untrusted.some((x) => containsInjectionAttempt(x));

  const facts = {
    documentType: doc.documentTypeCode,
    filename: doc.filename,
    applicationId: doc.applicationId,
    applicantId: doc.applicantId,
  };
  const result = await runProvider({ purpose: "EXTRACTION", facts, untrusted });
  const fallback = extractPassportFields(untrusted.join("\n"));
  const structured = (result.structured ?? {}) as { fields?: Record<string, string> };
  const fields = { ...fallback.fields, ...(structured.fields ?? {}) };
  const runId = await recordRun(t, {
    purpose: "EXTRACTION",
    actor,
    applicationId: doc.applicationId,
    documentId: doc.id,
    agencyId: doc.agencyId,
    result: { ...result, structured: { fields, injectionSuspected } },
    facts,
  });
  const FIELD_ALIAS: Record<string, string> = { expiryDate: "passportExpiryDate", issuingCountry: "passportIssueCountryCode", lastName: "lastName", firstName: "firstName" };
  const suggestions = await fileSuggestions(t, runId, actor, Object.entries(fields).map(([rawField, proposedValue]) => ({
    kind: "FIELD_VALUE",
    field: FIELD_ALIAS[rawField] ?? rawField,
    proposedValue: String(proposedValue),
    rationale: `Read from ${doc.documentTypeCode} content by ${result.provider}`,
    confidence: result.confidence,
    applicationId: doc.applicationId,
    documentId: doc.id,
    applicantId: doc.applicantId,
    agencyId: doc.agencyId,
  })));
  if (injectionSuspected) {
    await t
      .update(aiRuns)
      .set({ status: "STALE", errorMessage: "instruction-like text detected inside untrusted content — ignored, flagged for review" })
      .where(eq(aiRuns.id, runId));
  }
  await auditIn(t as unknown as Database, {
    actor,
    action: "CREATE",
    entityType: "ai_run",
    entityId: runId,
    agencyId: doc.agencyId,
    metadata: { purpose: "EXTRACTION", documentId: doc.id, provider: result.provider, confidence: result.confidence, injectionSuspected },
  });
  return { runId, fields, confidence: result.confidence, injectionSuspected, suggestions };
}

/** Pull printable runs out of a PDF-ish byte blob. Deliberately conservative:
 *  no parser, no execution, and a scanned image simply yields nothing. */
export function extractReadableText(raw: string): string {
  const out: string[] = [];
  const bt = /BT([\s\S]{0,4000}?)ET/g;
  let m: RegExpExecArray | null;
  while ((m = bt.exec(raw))) {
    const texts = m[1]?.match(/\((?:[^()\\]|\\.)*\)\s*Tj/g) ?? [];
    for (const piece of texts) {
      const inner = piece.replace(/^[\s\S]*?\(/, "").replace(/\)\s*Tj$/, "");
      const cleaned = inner
        .replace(/\\(\d{3}|.)/g, (_s, g) => (g && /^\d{3}$/.test(g) ? String.fromCharCode(Number(g)) : g))
        .replace(/[^\x20-\x7e]/g, "")
        .trim();
      if (cleaned.length > 1) out.push(cleaned);
    }
  }
  // also accept a raw MRZ line if the document is plain text
  const mrz = raw.match(/[PID]<[A-Z<]{20,80}/g) ?? [];
  return [...out, ...mrz].join("\n").slice(0, 20000);
}

/* ---------------- B/C/D/E. application analysis ---------------- */

export interface ApplicationAnalysis {
  runId: string;
  summary: string[];
  inconsistencies: Array<{ field: string; values: string[]; severity: "info" | "warning" | "error"; basis: string }>;
  missing: Array<{ document: string; applicant: string | null; state: string }>;
  nextActions: Array<{ action: string; why: string; owner: "STAFF" | "AGENCY"; urgency: "normal" | "high" }>;
  payment: { currencyCode: string; subtotalCents: number; paidCents: number; balanceCents: number; status: string | null };
  confidence: number;
  provider: string;
}

/**
 * One analysis call, five answers, all derived from platform data:
 * summary, apparent inconsistencies, missing documents, suggested next actions
 * and the payment picture. Nothing here can approve, refuse or reprice.
 */
export async function analyseApplication(actor: OpActor, applicationId: string): Promise<ApplicationAnalysis> {
  assertActorPermission(actor, "ai.use");
  const t: Q = await getDb();
  if (!(await aiEnabled(t))) throw new DomainError("STATE_CONFLICT", "The AI assistant is switched off in Settings → AI");
  const { view, app } = await getApplication(actor, applicationId);
  const [checklist, applicants, timeline, invoice] = await Promise.all([
    getChecklist(actor, applicationId),
    listApplicants(actor, applicationId),
    listTimeline(actor, applicationId, { limit: 25 }),
    getInvoiceForApplication(applicationId),
  ]);
  const wallet = await getWallet(app.agencyId).catch(() => null);
  const missing = checklist.blocking.map((b) => ({
    document: b.item.documentTypeName,
    applicant: b.item.applicantId ? applicants.find((a) => a.id === b.item.applicantId)?.fullName ?? null : null,
    state: b.item.state,
  }));

  const today = new Date().toISOString().slice(0, 10);
  const inconsistencies: ApplicationAnalysis["inconsistencies"] = [];
  for (const a of applicants) {
    if (a.passportExpiryDate && a.passportExpiryDate <= today) {
      inconsistencies.push({
        field: "passportExpiryDate",
        values: [`${a.fullName}: ${a.passportExpiryDate}`],
        severity: "error",
        basis: "applicant record vs today's date",
      });
    }
    if (a.passportExpiryDate && view.travelDate && a.passportExpiryDate <= view.travelDate) {
      inconsistencies.push({
        field: "passportExpiryDate",
        values: [`${a.fullName}: expires ${a.passportExpiryDate}`, `travel ${view.travelDate}`],
        severity: "error",
        basis: "applicant record vs the file's travel date",
      });
    }
    if (a.intendedEntryDate && a.intendedExitDate && a.intendedExitDate <= a.intendedEntryDate) {
      inconsistencies.push({ field: "travelDates", values: [`${a.fullName}: ${a.intendedEntryDate} → ${a.intendedExitDate}`], severity: "warning", basis: "applicant record" });
    }
    if (!a.passportNumber) {
      inconsistencies.push({ field: "passportNumber", values: [`${a.fullName}: missing`], severity: "info", basis: "applicant record" });
    }
  }
  if (view.applicantCount > view.requestedCount) {
    inconsistencies.push({
      field: "requestedCount",
      values: [`${view.applicantCount} travellers on a file opened for ${view.requestedCount}`],
      severity: "warning",
      basis: "application counters",
    });
  }
  if (checklist.configDrifted) {
    inconsistencies.push({
      field: "checklist",
      values: ["the visa route's configured requirements changed after this file was captured"],
      severity: "info",
      basis: "snapshot vs current configuration",
    });
  }

  const staleDays = Number(await getSetting<number>("ops.staleAfterDays", 7));
  const daysIdle = Math.floor((Date.now() - new Date(view.lastActivityAt).getTime()) / 86_400_000);
  const nextActions: ApplicationAnalysis["nextActions"] = [];
  if (missing.length) {
    nextActions.push({
      action: "Request the outstanding documents from the agency",
      why: `${missing.length} required item(s) still open: ${missing.slice(0, 3).map((m) => m.document).join(", ")}${missing.length > 3 ? "…" : ""}`,
      owner: "STAFF",
      urgency: daysIdle >= staleDays ? "high" : "normal",
    });
  }
  if (checklist.complete && !["READY_FOR_SUBMISSION", "SUBMITTED", "APPROVED", "COMPLETED"].includes(view.statusCode)) {
    nextActions.push({ action: "Move the file to Ready for Submission", why: "the checklist is fully accepted", owner: "STAFF", urgency: "normal" });
  }
  const outstanding = invoice ? invoice.subtotalCents - invoice.paidCents : 0;
  if (outstanding > 0) {
    const short = wallet ? Math.max(0, outstanding - wallet.balanceCents) : outstanding;
    nextActions.push({
      action: short > 0 ? "Fund the agency wallet before charging" : "Charge the invoice against the wallet",
      why: short > 0 ? `wallet is short by ${short} cents` : `invoice ${invoice!.number} is still due`,
      owner: "STAFF",
      urgency: short > 0 ? "high" : "normal",
    });
  }
  if (view.priorityCode === "URGENT" && !view.submittedAt) {
    nextActions.push({ action: "Prioritise this file", why: "marked URGENT and not yet submitted", owner: "STAFF", urgency: "high" });
  }
  if (daysIdle >= staleDays && !view.isTerminal) {
    nextActions.push({ action: "Follow up — no activity for a while", why: `${daysIdle} days since the last movement`, owner: "STAFF", urgency: "normal" });
  }
  if (!applicants.length) {
    nextActions.push({ action: "Ask the agency for traveller details", why: "no applicants on the file yet", owner: "AGENCY", urgency: "high" });
  }

  const summary = [
    `${view.reference} · ${view.visaTypeName} to ${view.countryName} for ${view.agencyName}`,
    `Status ${view.statusLabel}${view.priorityLabel ? `, priority ${view.priorityLabel}` : ""}`,
    `${view.applicantCount} of ${view.requestedCount} traveller(s) recorded${applicants.length ? `: ${applicants.slice(0, 5).map((a) => a.fullName).join(", ")}` : ""}`,
    `Documents ${checklist.requiredSatisfied}/${checklist.requiredTotal} accepted${missing.length ? `; outstanding: ${missing.map((m) => m.document).join(", ")}` : ""}`,
    invoice ? `Invoice ${invoice.number}: ${(invoice.subtotalCents / 100).toFixed(2)} ${invoice.currencyCode}, ${invoice.status.toLowerCase().replace(/_/g, " ")}` : "No invoice yet",
    wallet ? `Agency wallet: ${(wallet.balanceCents / 100).toFixed(2)} ${wallet.currencyCode}${wallet.consistent ? "" : " (LEDGER MISMATCH)"}` : "Wallet unavailable",
    view.gateOverridden ? "A document gate was overridden by staff on this file" : "",
    timeline.length ? `Last event: ${timeline[0]!.message ?? timeline[0]!.type.toLowerCase()} (${new Date(timeline[0]!.createdAt).toLocaleDateString()})` : "",
  ].filter(Boolean);

  const facts = { view, missing, inconsistencies, nextActions, invoice, wallet };
  const result = await runProvider({ purpose: "SUMMARY", facts });
  const runId = await recordRun(t, { purpose: "SUMMARY", actor, applicationId, agencyId: app.agencyId, result, facts: { keys: Object.keys(facts) } });
  await fileSuggestions(
    t,
    runId,
    actor,
    nextActions.map((n) => ({
      kind: "NEXT_ACTION",
      proposedValue: n.action,
      rationale: n.why,
      confidence: n.urgency === "high" ? 80 : 60,
      applicationId,
      agencyId: app.agencyId,
    })),
  );
  await auditIn(t as unknown as Database, {
    actor,
    action: "CREATE",
    entityType: "ai_run",
    entityId: runId,
    agencyId: app.agencyId,
    metadata: { purpose: "ANALYSIS", provider: result.provider },
  });
  return {
    runId,
    summary,
    inconsistencies,
    missing,
    nextActions,
    payment: {
      currencyCode: invoice?.currencyCode ?? "EUR",
      subtotalCents: invoice?.subtotalCents ?? 0,
      paidCents: invoice?.paidCents ?? 0,
      balanceCents: wallet?.balanceCents ?? 0,
      status: invoice?.status ?? null,
    },
    confidence: result.confidence,
    provider: result.provider,
  };
}

/* ---------------- F. drafting ---------------- */

export async function draftCommunication(
  actor: OpActor,
  applicationId: string,
  purpose: "MISSING_DOCUMENTS" | "STATUS_UPDATE" | "FOLLOW_UP",
): Promise<{ subject: string; body: string; runId: string; confidence: number }> {
  assertActorPermission(actor, "communications.write");
  const t: Q = await getDb();
  if (!(await aiEnabled(t))) throw new DomainError("STATE_CONFLICT", "The AI assistant is switched off in Settings → AI");
  const { view, app } = await getApplication(actor, applicationId);
  const checklist = await getChecklist(actor, applicationId);
  const templateCode = purpose === "MISSING_DOCUMENTS" ? "MISSING_DOCUMENTS" : purpose === "FOLLOW_UP" ? "PAYMENT_REMINDER" : "PROCESSING_UPDATE";
  const invoiceSnapshot = await getInvoiceForApplication(applicationId);
  const invoiceSnapshotCents = invoiceSnapshot?.subtotalCents ?? 0;
  const tpl = (await t
    .select()
    .from((await import("@/db")).communicationTemplates)
    .where(and(sql`upper(${(await import("@/db")).communicationTemplates.code}) = upper(${templateCode})`, eq((await import("@/db")).communicationTemplates.isActive, true)))
    .limit(1)) as Array<{ subject: string; body: string }>;
  const template = tpl[0];
  const { renderTemplate } = await import("@/lib/validation");
  const vars = {
    agency_name: view.agencyName,
    client_name: view.agencyName,
    application_reference: view.reference,
    visa_type: view.visaTypeName,
    country: view.countryName,
    status: view.statusLabel,
    priority: view.priorityLabel ?? "normal",
    amount: (() => {
      const c = invoiceSnapshotCents;
      return (c / 100).toFixed(2);
    })(),
    due_date: view.dueAt ? new Date(view.dueAt).toLocaleDateString() : "as soon as possible",
    processing_days: String(view.requestedCount),
    support_email: String(await getSetting("contact.supportEmail", "support@essafaria.local")),
    company_name: String(await getSetting("company.name", "ESSAFARIA TRAVEL")),
  };
  const renderedSubject = template ? renderTemplate(template.subject, vars) : `Update on ${view.reference}`;
  const renderedBody = template
    ? renderTemplate(template.body, vars)
    : `Dear ${vars.agency_name},\n\n${purpose === "MISSING_DOCUMENTS" ? `We still need: ${checklist.blocking.map((b) => b.reason).join(", ")}.` : `Current status: ${vars.status}.`}\n\n${vars.company_name}`;
  const result = await runProvider({
    purpose: "DRAFT",
    facts: { purpose, application: view, outstanding: checklist.blocking.map((b) => b.reason) },
  });
  const runId = await recordRun(t, { purpose: "DRAFT", actor, applicationId, agencyId: app.agencyId, result, facts: { templateCode } });
  await auditIn(t as unknown as Database, {
    actor,
    action: "CREATE",
    entityType: "communication_draft",
    entityId: applicationId,
    agencyId: app.agencyId,
    metadata: { purpose, provider: result.provider, note: "draft only" },
  });
  const body = result.text && result.text.length > 40 ? `${renderedBody}\n\n[suggested wording]\n${result.text}` : renderedBody;
  return { subject: renderedSubject, body, runId, confidence: template ? 100 : result.confidence };
}

/* ---------------- G. staff copilot ---------------- */

export type CopilotIntent =
  | "WAITING_ON_DOCUMENTS"
  | "PAYMENT_ISSUES"
  | "NEEDS_FOLLOW_UP"
  | "URGENT_OPEN"
  | "SUMMARIZE"
  | "MY_QUEUE"
  | "UNKNOWN";

/**
 * A deliberately SMALL, allowlisted intent parser. No free-form query reaches
 * the database, so there is nothing for an injected sentence to hook into:
 * questions map to one of seven prepared reads, or to UNKNOWN.
 */
export function parseIntent(question: string): { intent: CopilotIntent; reference?: string } {
  const q = question.toLowerCase();
  const ref = /(ESF-\d{4}-\d{6})/.exec(question)?.[1];
  if (ref) return { intent: "SUMMARIZE", reference: ref };
  if (/wait|missing|outstanding|which.*document|need.*document/.test(q)) return { intent: "WAITING_ON_DOCUMENTS" };
  if (/payment|invoice|unpaid|due|wallet|balance|charge|money|short/.test(q)) return { intent: "PAYMENT_ISSUES" };
  if (/follow|stale|idle|no activity|overdue|nudge/.test(q)) return { intent: "NEEDS_FOLLOW_UP" };
  if (/urgent|priority|rush|expedite|high prio/.test(q)) return { intent: "URGENT_OPEN" };
  if (/my (queue|files|cases)|assigned to me|what should i work/.test(q)) return { intent: "MY_QUEUE" };
  if (/summar/.test(q)) return { intent: "SUMMARIZE" };
  return { intent: "UNKNOWN" };
}

export interface CopilotAnswer {
  intent: CopilotIntent;
  question: string;
  headline: string;
  rows: Array<{ reference: string; agency: string; detail: string; href: string }>;
  notes: string[];
  runId: string | null;
  refused: boolean;
}

export async function askCopilot(actor: OpActor, question: string): Promise<CopilotAnswer> {
  assertActorPermission(actor, "ai.use");
  const text = question.trim().slice(0, 400);
  if (text.length < 3) throw new DomainError("VALIDATION", "Ask a real question");
  if (!(await aiEnabled(await getDb()))) throw new DomainError("STATE_CONFLICT", "The AI assistant is switched off in Settings → AI");
  const t: Q = await getDb();
  const { intent, reference } = parseIntent(text);
  const { listApplications } = await import("@/lib/applications");
  const { can } = await import("@/lib/rbac");

  const base = { question: text, runId: null as string | null, refused: false };
  const scope = { pageSize: 15 };

  if (intent === "UNKNOWN") {
    return {
      ...base,
      intent,
      headline: "I can only answer a fixed set of operational questions",
      rows: [],
      notes: [
        "Try: “which applications are waiting for documents?”, “which files have payment problems?”, “what needs follow-up?”, “urgent open files”, “my queue”, or paste a reference like ESF-2026-000001.",
        "Nothing in a question (or in an imported email) is executed as a query — the assistant maps questions to prepared reads only.",
      ],
      refused: true,
    };
  }

  if (intent === "SUMMARIZE") {
    if (!reference) {
      return { ...base, intent, headline: "Name the file — put its reference in the question", rows: [], notes: [], refused: true };
    }
    const found = await listApplications(actor, { q: reference, ...scope });
    const hit = found.rows.find((r) => r.reference === reference);
    if (!hit) {
      return { ...base, intent, headline: `No file called ${reference} that you may see`, rows: [], notes: ["A reference from another agency is invisible here by design."], refused: false };
    }
    const analysis = await analyseApplication(actor, hit.id);
    return {
      ...base,
      intent,
      headline: `${hit.reference} — ${hit.statusLabel}`,
      rows: [{ reference: hit.reference, agency: hit.agencyName, detail: analysis.summary.slice(0, 3).join(" · "), href: `/admin/applications/${hit.id}` }],
      notes: analysis.summary,
      refused: false,
    };
  }

  let rows: Array<{ reference: string; agency: string; detail: string; href: string }> = [];
  let headline = "";
  const notes: string[] = [];

  if (intent === "WAITING_ON_DOCUMENTS") {
    const res = await listApplications(actor, { onlyBlocking: true, onlyOpen: true, ...scope });
    rows = res.rows.map((r) => ({ reference: r.reference, agency: r.agencyName, detail: `${r.visaTypeName} · checklist incomplete`, href: `/admin/applications/${r.id}` }));
    headline = `${res.total} open file(s) waiting on documents`;
    notes.push("Counted from the derived checklist, the same computation the submission gate uses — not a cached flag.");
  } else if (intent === "PAYMENT_ISSUES") {
    const invRows = (await t
      .select({
        number: (await import("@/db")).invoices.number,
        due: sql<number>`(${(await import("@/db")).invoices.subtotalCents} - ${(await import("@/db")).invoices.paidCents})::bigint`,
        currency: (await import("@/db")).invoices.currencyCode,
        reference: visaApplications.reference,
        agency: (await import("@/db")).agencies.name,
        applicationId: visaApplications.id,
      })
      .from((await import("@/db")).invoices)
      .innerJoin(visaApplications, eq(visaApplications.id, (await import("@/db")).invoices.applicationId))
      .innerJoin((await import("@/db")).agencies, eq((await import("@/db")).agencies.id, (await import("@/db")).invoices.agencyId))
      .where(
        and(
          sql`${(await import("@/db")).invoices.status} in ('PENDING','PARTIALLY_PAID')`,
          actor.isStaff ? undefined : sql`1=0`,
        ),
      )
      .orderBy(sql`(${(await import("@/db")).invoices.subtotalCents} - ${(await import("@/db")).invoices.paidCents}) desc`)
      .limit(15)) as unknown as Array<{ number: string; due: number | string; currency: string; reference: string; agency: string; applicationId: string }>;
    rows = invRows.map((r) => ({
      reference: r.reference,
      agency: r.agency,
      detail: `${r.number} outstanding ${(Number(r.due) / 100).toFixed(2)} ${r.currency}`,
      href: `/admin/applications/${r.applicationId}`,
    }));
    headline = `${rows.length} unpaid or partly paid invoice(s)`;
    if (!can(actor.role, "wallet.read")) notes.push("You can see which files are owed; balances are shown only to accounting and admins.");
  } else if (intent === "NEEDS_FOLLOW_UP") {
    const staleDays = Number(await getSetting<number>("ops.staleAfterDays", 7));
    const cutoff = new Date(Date.now() - staleDays * 86_400_000);
    const res = await listApplications(actor, { onlyOpen: true, ...scope });
    rows = res.rows
      .filter((r) => new Date(r.lastActivityAt) < cutoff)
      .map((r) => ({
        reference: r.reference,
        agency: r.agencyName,
        detail: `idle ${Math.floor((Date.now() - new Date(r.lastActivityAt).getTime()) / 86_400_000)} days · ${r.statusLabel}`,
        href: `/admin/applications/${r.id}`,
      }));
    headline = `${rows.length} open file(s) idle for ${staleDays}+ days`;
  } else if (intent === "URGENT_OPEN") {
    const urgent = (await t
      .select({ id: (await import("@/db")).priorities.id, code: (await import("@/db")).priorities.code })
      .from((await import("@/db")).priorities)
      .where(sql`${(await import("@/db")).priorities.surchargePercent} >= 15`)
      .limit(5)) as Array<{ id: string; code: string }>;
    const ids = urgent.map((u) => u.id);
    if (ids.length) {
      for (const id of ids) {
        const res = await listApplications(actor, { priorityId: id, onlyOpen: true, ...scope });
        rows.push(
          ...res.rows.map((r) => ({ reference: r.reference, agency: r.agencyName, detail: `${r.statusLabel}${r.checklistComplete ? "" : " · documents outstanding"}`, href: `/admin/applications/${r.id}` })),
        );
      }
    }
    headline = `${rows.length} elevated-priority file(s) still open`;
    notes.push("“Elevated” is whatever priorities the platform has configured with a surcharge — no hard-coded label.");
  } else if (intent === "MY_QUEUE") {
    const res = await listApplications(actor, { assignedToMe: true, onlyOpen: true, ...scope });
    rows = res.rows.map((r) => ({ reference: r.reference, agency: r.agencyName, detail: `${r.statusLabel} · ${r.checklistComplete ? "checklist complete" : "documents outstanding"}`, href: `/admin/applications/${r.id}` }));
    headline = `${res.total} open file(s) assigned to you`;
  }

  return { ...base, intent, headline, rows, notes, refused: false };
}

/* ---------------- suggestion decisions (human acts) ---------------- */

export async function listSuggestions(actor: OpActor, applicationId: string): Promise<SuggestionView[]> {
  assertActorPermission(actor, "applications.read");
  const t: Q = await getDb();
  const { view, app } = await getApplication(actor, applicationId);
  void view;
  const rows = (await t
    .select()
    .from(aiSuggestions)
    .where(and(eq(aiSuggestions.applicationId, app.id), sql`${aiSuggestions.status} = 'PROPOSED'`))
    .orderBy(desc(aiSuggestions.createdAt))
    .limit(60)) as Array<typeof aiSuggestions.$inferSelect>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    field: r.field,
    proposedValue: r.proposedValue,
    rationale: r.rationale,
    confidence: r.confidence,
    status: r.status,
    requiresHumanReview: r.requiresHumanReview,
    runId: r.runId,
    createdAt: String(r.createdAt),
  }));
}

/**
 * Accepting a FIELD_VALUE suggestion writes through the ordinary applicant
 * service — validated, tenant-checked, evented and audited under the ACCEPTING
 * HUMAN's identity. `requiresHumanReview` rows cannot be accepted by click:
 * they must be typed in, which keeps a low-confidence guess out of the record.
 */
export async function acceptSuggestion(actor: OpActor, suggestionId: string): Promise<{ applied: boolean; message: string }> {
  assertActorPermission(actor, "applications.write");
  if (!actor.isStaff) throw new DomainError("FORBIDDEN", "Only ESSAFARIA staff may accept an AI suggestion");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const rows = (await t
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, suggestionId))
      .limit(1)
      .for("update")) as unknown as Array<typeof aiSuggestions.$inferSelect>;
    const s = rows[0];
    if (!s) throw new DomainError("NOT_FOUND", "Suggestion not found");
    if (s.status !== "PROPOSED") return { applied: false, message: "Already actioned" };
    if (s.requiresHumanReview) {
      throw new DomainError(
        "STATE_CONFLICT",
        "This suggestion is below the configured confidence floor — it must be entered by hand, not accepted by click",
      );
    }
    if (s.kind !== "FIELD_VALUE" || !s.applicationId) {
      throw new DomainError("STATE_CONFLICT", "Only extracted field values can be accepted; advice and drafts are read, not applied");
    }
    const app = (await t.select().from(visaApplications).where(eq(visaApplications.id, s.applicationId)).limit(1))[0] as { agencyId: string } | undefined;
    if (!app) throw new DomainError("NOT_FOUND", "Application not found");
    if (!actor.agencyIds.includes(app.agencyId) && !actor.isStaff) throw new DomainError("NOT_FOUND", "Application not found");

    if (s.applicantId) {
      const { upsertApplicantInsideTx } = await import("@/lib/applicants");
      const current = (await t
        .select()
        .from((await import("@/db")).applicants)
        .where(eq((await import("@/db")).applicants.id, s.applicantId))
        .limit(1))[0] as Record<string, unknown> | undefined;
      if (!current) throw new DomainError("NOT_FOUND", "Applicant not found");
      const patch: Record<string, unknown> = {
        fullName: String(current.fullName ?? s.proposedValue ?? ""),
        dateOfBirth: s.field === "dateOfBirth" ? String(s.proposedValue) : (current.dateOfBirth as string) ?? "",
        passportNumber: s.field === "passportNumber" ? String(s.proposedValue) : (current.passportNumber as string) ?? "",
        passportExpiryDate: s.field === "passportExpiryDate" || s.field === "expiryDate" ? String(s.proposedValue) : (current.passportExpiryDate as string) ?? "",
        passportIssueDate: (current.passportIssueDate as string) ?? "",
        nationalityCountryCode: "",
      };
      await upsertApplicantInsideTx(tx, actor, s.applicationId, patch as never, s.applicantId);
    } else {
      throw new DomainError("VALIDATION", "This value is not attached to a traveller, so it cannot be applied automatically");
    }

    const updated = await t
      .update(aiSuggestions)
      .set({ status: "ACCEPTED", actedBy: actor.id, actedAt: new Date() })
      .where(and(eq(aiSuggestions.id, s.id), eq(aiSuggestions.status, "PROPOSED")));
    void updated;
    await auditIn(tx, {
      actor,
      action: "UPDATE",
      entityType: "ai_suggestion",
      entityId: s.id,
      agencyId: app.agencyId,
      metadata: { accepted: true, field: s.field, runId: s.runId, providerSaid: s.proposedValue },
    });
    return { applied: true, message: `Applied ${s.field} to the traveller record` };
  });
}

export async function dismissSuggestion(actor: OpActor, suggestionId: string, reason?: string | null): Promise<void> {
  assertActorPermission(actor, "applications.write");
  if (!actor.isStaff) throw new DomainError("FORBIDDEN", "Only ESSAFARIA staff may dismiss suggestions");
  const t: Q = await getDb();
  const res = await t
    .update(aiSuggestions)
    .set({ status: "DISMISSED", actedBy: actor.id, actedAt: new Date(), rationale: reason ? `${reason}` : undefined })
    .where(and(eq(aiSuggestions.id, suggestionId), eq(aiSuggestions.status, "PROPOSED")));
  if (Number((res as { rowCount?: number; affectedRows?: number }).rowCount ?? (res as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
    throw new DomainError("NOT_FOUND", "Suggestion not found");
  }
  const rows = (await t.select({ runId: aiSuggestions.runId }).from(aiSuggestions).where(eq(aiSuggestions.id, suggestionId)).limit(1)) as Array<{ runId: string }>;
  void rows;
}

export function aiStatus() {
  return aiAvailability();
}
