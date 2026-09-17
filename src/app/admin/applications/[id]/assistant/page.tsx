import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { AiNote, Field, Form, Notice, Panel, StateChip } from "@/components/ops/ui";
import { getApplication, type ApplicationView } from "@/lib/applications";
import { listApplicants, type ApplicantView } from "@/lib/applicants";
import { listDocuments, type DocumentView } from "@/lib/documents";
import { aiStatus, analyseApplication, listSuggestions, type ApplicationAnalysis } from "@/lib/ai";
import { getDb, aiRuns } from "@/db";
import { staffActorForPage } from "@/lib/page-auth";
import { acceptSuggestionAction, dismissSuggestionAction, generateDraftAction, runAnalysisAction, runExtractionAction } from "@/app/admin/assistant-actions";
import { getSetting } from "@/lib/config-service";

export const dynamic = "force-dynamic";

type Q = any;

/**
 * The staff assistant for one file. Every panel is labelled as advisory, shows
 * confidence and the basis it used, and offers at most a human-confirmed action.
 */
export default async function ApplicationAssistantPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { flash?: string; draft?: string };
}) {
  const actor = await staffActorForPage("ai.use");
  let analysis: ApplicationAnalysis | null = null;
  let view: ApplicationView;
  let applicants: ApplicantView[] = [];
  let documents: DocumentView[] = [];
  try {
    ({ view } = await getApplication(actor, params.id));
    [analysis, applicants, documents] = await Promise.all([
      analyseApplication(actor, params.id).catch(() => null),
      listApplicants(actor, params.id),
      listDocuments(actor, params.id),
    ]);
  } catch {
    notFound();
  }
  const suggestions = await listSuggestions(actor, params.id);
  const enabled = await getSetting<boolean>("ai.enabled", true);
  const status = aiStatus();
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;

  let draft: { subject: string; body: string } | null = null;
  if (searchParams.draft) {
    const t: Q = await getDb();
    const row = (await t
      .select({ output: aiRuns.output })
      .from(aiRuns)
      .where(and(eq(aiRuns.id, searchParams.draft), eq(aiRuns.purpose, "DRAFT")))
      .limit(1))[0] as { output: { text?: string; structured?: Record<string, unknown> } | null } | undefined;
    void row;
  }
  void draft;

  return (
    <div className="pb-16">
      <PageHeader
        title={`Assistant — ${view.reference}`}
        subtitle={`${view.visaTypeName} · ${view.agencyName} · provider ${status.provider} (${status.note})`}
        action={
          <Link href={`/admin/applications/${view.id}`} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
            Back to file
          </Link>
        }
      />
      {flash ? (
        <div className="mb-4">
          <Notice kind={searchParams.flash?.startsWith("err") ? "error" : "info"}>{flash}</Notice>
        </div>
      ) : null}
      {enabled === false ? (
        <div className="mb-4">
          <Notice kind="warn">The assistant is switched off in Settings → AI. Nothing here will run until it is enabled.</Notice>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel
            title="Summary"
            subtitle="Composed from the file, its travellers, the derived checklist, the invoice and the wallet. No sentence in here came from a model inventing facts."
            action={
              <form action={runAnalysisAction}>
                <input type="hidden" name="applicationId" value={view.id} />
                <button type="submit" className="btn-brand !px-3 !py-1.5 text-xs">
                  Re-run analysis
                </button>
              </form>
            }
          >
            {analysis ? (
              <AiNote confidence={analysis.confidence} basis={[`provider: ${analysis.provider}`, "platform queries"]}>
                <ul className="list-disc space-y-1 pl-4">
                  {analysis.summary.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </AiNote>
            ) : (
              <EmptyState title="Analysis unavailable" hint="Enable the assistant in Settings → AI, then re-run." />
            )}
          </Panel>

          <Panel title="Apparent inconsistencies" subtitle="Flagged for a person to look at. A flag is never a decision.">
            {!analysis?.inconsistencies.length ? (
              <p className="text-xs text-slate-500">Nothing flagged.</p>
            ) : (
              <ul className="space-y-2">
                {analysis.inconsistencies.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-slate-200 p-3">
                    <div className="min-w-0">
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-600">{c.field}</p>
                      <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
                        {c.values.map((v, j) => (
                          <li key={j}>{v}</li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[11px] text-slate-400">basis: {c.basis}</p>
                    </div>
                    <Badge tone={c.severity === "error" ? "red" : c.severity === "warning" ? "amber" : "slate"}>{c.severity}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Suggested next actions" subtitle="Advice for the desk. The buttons on the file itself still do the work.">
            {!analysis?.nextActions.length ? (
              <p className="text-xs text-slate-500">No action suggested — the file is moving.</p>
            ) : (
              <ol className="space-y-2">
                {analysis.nextActions.map((n, i) => (
                  <li key={i} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-slate-50 p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{n.action}</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">{n.why}</p>
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge tone={n.owner === "AGENCY" ? "navy" : "slate"}>{n.owner === "AGENCY" ? "agency to act" : "staff to act"}</Badge>
                      {n.urgency === "high" ? <Badge tone="amber">high</Badge> : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Extracted values awaiting a decision" subtitle="Only values at or above the configured confidence floor can be accepted by click; anything lower must be typed in.">
            {!suggestions.length ? (
              <EmptyState title="No open suggestions" hint="Run extraction on a document to populate this list." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {suggestions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800">
                        {s.field ?? s.kind}
                        <span className="ml-2 text-xs font-normal text-slate-500">→ {s.proposedValue}</span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500">{s.rationale}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">{s.confidence}%</span>
                      {s.requiresHumanReview ? <StateChip state="PENDING_REVIEW" /> : null}
                      {!s.requiresHumanReview ? (
                        <Form action={acceptSuggestionAction} submitLabel="Accept" applicationId={view.id} back={`/admin/applications/${view.id}/assistant`}>
                          <input type="hidden" name="suggestionId" value={s.id} />
                        </Form>
                      ) : null}
                      <Form action={dismissSuggestionAction} submitLabel="Dismiss" tone="ghost" applicationId={view.id} back={`/admin/applications/${view.id}/assistant`}>
                        <input type="hidden" name="suggestionId" value={s.id} />
                      </Form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Read a document" subtitle="Scans the stored bytes for a machine-readable zone or labelled text. Nothing is written automatically.">
            {!documents.filter((d) => d.isCurrent).length ? (
              <EmptyState title="No documents yet" />
            ) : (
              <ul className="space-y-2">
                {documents
                  .filter((d) => d.isCurrent)
                  .map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-slate-700">{d.documentTypeName}</p>
                        <p className="truncate text-[11px] text-slate-500">
                          {d.filename} · {d.applicantId ? applicants.find((a) => a.id === d.applicantId)?.fullName ?? "traveller" : "file-level"}
                        </p>
                      </div>
                      <form action={runExtractionAction} className="shrink-0">
                        <input type="hidden" name="documentId" value={d.id} />
                        <input type="hidden" name="applicationId" value={view.id} />
                        <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100">
                          Extract
                        </button>
                      </form>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          <Panel title="Draft a message" subtitle="Built from the configured communication template and this file's facts. It is stored as text for a person to send.">
            <Form action={generateDraftAction} submitLabel="Compose draft" back={`/admin/applications/${view.id}/assistant`} applicationId={view.id}>
              <Field
                as="select"
                name="purpose"
                label="Purpose"
                defaultValue="MISSING_DOCUMENTS"
                options={[
                  { value: "MISSING_DOCUMENTS", label: "Chase outstanding documents" },
                  { value: "STATUS_UPDATE", label: "Status update" },
                  { value: "FOLLOW_UP", label: "Payment follow-up" },
                ]}
              />
            </Form>
            <p className="mt-2 text-[11px] text-slate-400">
              The assistant never sends. Gmail replies land as drafts in the connected mailbox, and portal messages are added to the file by a person.
            </p>
          </Panel>

          <Panel title="Payment picture">
            {analysis ? (
              <ul className="space-y-1.5 text-xs">
                <li className="flex justify-between">
                  <span className="text-slate-500">Invoice total</span>
                  <span className="font-semibold tabular-nums">
                    {(analysis.payment.subtotalCents / 100).toFixed(2)} {analysis.payment.currencyCode}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span className="text-slate-500">Collected</span>
                  <span className="font-semibold tabular-nums">
                    {(analysis.payment.paidCents / 100).toFixed(2)} {analysis.payment.currencyCode}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span className="text-slate-500">Agency wallet</span>
                  <span className="font-semibold tabular-nums">
                    {(analysis.payment.balanceCents / 100).toFixed(2)} {analysis.payment.currencyCode}
                  </span>
                </li>
              </ul>
            ) : null}
            <Link href="/admin/wallet" className="mt-3 block text-[11px] font-semibold text-[var(--color-brand-primary)] hover:underline">
              Open the wallet desk →
            </Link>
          </Panel>
        </div>
      </div>
    </div>
  );
}
