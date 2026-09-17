import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Field, Form, Money, Notice, Panel, StateChip } from "@/components/ops/ui";
import { getApplication, getChecklist } from "@/lib/applications";
import { listDocuments, pendingReviewQueue } from "@/lib/documents";
import { listApplicants } from "@/lib/applicants";
import { documentTypeOptions } from "@/lib/options";
import { staffActorForPage } from "@/lib/page-auth";
import { requestDocumentsAction, reviewDocumentAction, uploadDocumentAction, withdrawDocumentAction } from "@/app/ops-actions";

export const dynamic = "force-dynamic";

/**
 * Staff document desk for one file: review queue, ad-hoc attachment, and the
 * "chase the agency" action. States come from the derived checklist, so what a
 * reviewer sees is exactly what the gate enforces.
 */
export default async function StaffDocumentsDesk({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { flash?: string };
}) {
  const actor = await staffActorForPage("applications.read");
  let view;
  try {
    ({ view } = await getApplication(actor, params.id));
  } catch {
    notFound();
  }
  const [documents, checklist, applicants, types, queue] = await Promise.all([
    listDocuments(actor, params.id),
    getChecklist(actor, params.id),
    listApplicants(actor, params.id),
    documentTypeOptions(),
    pendingReviewQueue(actor, 12),
  ]);
  const current = documents.filter((d) => d.isCurrent);
  const history = documents.filter((d) => !d.isCurrent);
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;
  const applicantOptions = applicants.map((a) => ({ value: a.id, label: a.fullName }));

  return (
    <div className="pb-16">
      <PageHeader
        title={`Documents — ${view.reference}`}
        subtitle={`${view.visaTypeName} · ${view.agencyName}`}
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

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-2xl font-black tabular-nums" style={{ color: "var(--color-brand-primary)" }}>
            {checklist.requiredSatisfied}/{checklist.requiredTotal}
          </p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Required documents accepted</p>
        </div>
        <div className="card p-4">
          <p className="text-2xl font-black tabular-nums">{current.length}</p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Current files on the folder</p>
        </div>
        <div className={`card p-4 ${queue.length ? "ring-1 ring-amber-200" : ""}`}>
          <p className="text-2xl font-black tabular-nums">{queue.length}</p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Awaiting review across the desk</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Panel title="Current documents" subtitle="Each decision is written with the notification and the audit row in one transaction.">
            {!current.length ? (
              <EmptyState title="Nothing uploaded yet" />
            ) : (
              <ul className="space-y-4">
                {current.map((d) => (
                  <li key={d.id} className="rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-800">
                          {d.documentTypeName}
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">v{d.version}</span>
                          {d.wasRequiredAtUpload ? null : <Badge tone="slate">extra</Badge>}
                          <StateChip state={d.reviewState} />
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {d.applicantName ? `${d.applicantName} · ` : "whole file · "}
                          {(d.bytes / 1024).toFixed(0)} KB · {d.mimeType} · uploaded {new Date(d.uploadedAt).toLocaleString()}
                          {d.expiresAt ? ` · valid until ${new Date(d.expiresAt).toLocaleDateString()}` : ""}
                        </p>
                        {d.agencyNotes ? <p className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-600">{d.agencyNotes}</p> : null}
                        {d.staffNotes ? <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">Internal: {d.staffNotes}</p> : null}
                        {d.rejectionCode ? <p className="mt-2 text-[11px] font-semibold text-red-700">Rejection code: {d.rejectionCode}</p> : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <a href={`/api/documents/${d.id}/content`} target="_blank" rel="noreferrer" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100">
                          Open
                        </a>
                        <Link href={`/api/documents/${d.id}/content`} prefetch={false} className="hidden" aria-hidden>
                          —
                        </Link>
                      </div>
                    </div>
                    <form action={reviewDocumentAction} className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_auto]">
                      <input type="hidden" name="__applicationId" value={view.id} />
                      <input type="hidden" name="__documentId" value={d.id} />
                      <input type="hidden" name="__back" value={`/admin/applications/${view.id}/documents`} />
                      <div>
                        <label className="label" htmlFor={`dec-${d.id}`}>Decision</label>
                        <select id={`dec-${d.id}`} name="decision" className="input text-xs">
                          <option value="ACCEPT">Accept</option>
                          <option value="REJECT">Reject</option>
                          <option value="NEEDS_REPLACEMENT">Needs replacement</option>
                        </select>
                      </div>
                      <div>
                        <label className="label" htmlFor={`note-${d.id}`}>Note to the agency</label>
                        <input id={`note-${d.id}`} name="note" className="input text-xs" placeholder="required when rejecting" />
                      </div>
                      <div className="flex items-end gap-2">
                        <input name="rejectionCode" className="input !w-28 text-xs" placeholder="code" />
                        <button type="submit" className="btn-brand !px-3 !py-2 text-xs whitespace-nowrap">
                          Record
                        </button>
                      </div>
                    </form>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-semibold text-red-700">Withdraw this document</summary>
                      <form action={withdrawDocumentAction} className="mt-2 flex flex-wrap items-end gap-2">
                        <input type="hidden" name="__applicationId" value={view.id} />
                        <input type="hidden" name="__documentId" value={d.id} />
                        <input type="hidden" name="__back" value={`/admin/applications/${view.id}/documents`} />
                        <div className="min-w-[240px] flex-1">
                          <label className="label" htmlFor={`wd-${d.id}`}>Reason (mandatory)</label>
                          <input id={`wd-${d.id}`} name="reason" className="input text-xs" required minLength={5} />
                        </div>
                        <button type="submit" className="rounded-md border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50">
                          Withdraw
                        </button>
                      </form>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {history.length ? (
            <Panel title="Superseded versions" subtitle="Replacements never destroy history — reviewers can still see what was on the file.">
              <ul className="divide-y divide-slate-100 text-xs">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="font-semibold text-slate-700">
                      {h.documentTypeName} v{h.version}
                      {h.applicantName ? ` · ${h.applicantName}` : ""}
                    </span>
                    <span className="flex items-center gap-2 text-slate-500">
                      {h.reviewState === "SUPERSEDED" ? <Badge tone="slate">superseded</Badge> : <StateChip state={h.reviewState} />}
                      {new Date(h.uploadedAt).toLocaleDateString()}
                      <a href={`/api/documents/${h.id}/content`} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                        open
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel title="Outstanding on the checklist" subtitle="Live from the file's frozen requirement set.">
            {!checklist.blocking.length ? (
              <Notice kind="info">Nothing outstanding — every required document is accepted.</Notice>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {checklist.blocking.map((b, i) => (
                  <li key={i} className="rounded-lg border border-red-100 bg-red-50/60 px-3 py-2 text-red-800">
                    {b.reason}
                  </li>
                ))}
              </ul>
            )}
            <form action={requestDocumentsAction} className="mt-4 space-y-2">
              <input type="hidden" name="__applicationId" value={view.id} />
              <input type="hidden" name="__back" value={`/admin/applications/${view.id}/documents`} />
              <Field as="textarea" name="note" label="Add a line to the request" rows={2} />
              <button type="submit" className="btn-brand w-full !py-2 text-xs">
                Ask the agency for these
              </button>
            </form>
          </Panel>

          <Panel title="Attach a document" subtitle="Staff may attach anything relevant; items outside the checklist are marked so they never appear to satisfy a requirement.">
            <Form action={uploadDocumentAction} submitLabel="Upload" back={`/admin/applications/${view.id}/documents`} applicationId={view.id}>
              <Field as="file" name="file" label="File" required accept=".pdf,.png,.jpg,.jpeg,.webp" hint="PDF, PNG, JPEG or WebP · sniffed server-side" />
              <Field as="select" name="documentTypeCode" label="Document type" options={types.map((x) => ({ value: x.code, label: x.label }))} required />
              <Field as="select" name="applicantId" label="Traveller" options={applicantOptions} hint="Leave empty for a file-level document" />
              <Field as="textarea" name="agencyNotes" label="Note for the agency" rows={2} />
            </Form>
          </Panel>

          <Panel title="Desk review queue" subtitle="Files waiting on someone, oldest upload first.">
            {!queue.length ? (
              <EmptyState title="Queue is clear" />
            ) : (
              <ul className="space-y-2 text-xs">
                {queue.map((q) => (
                  <li key={q.id} className="flex items-center justify-between gap-2">
                    <Link href={`/admin/applications/${q.applicationId}/documents`} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                      {q.reference}
                    </Link>
                    <span className="text-slate-500">
                      {q.documentTypeName} · {new Date(q.uploadedAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
