import { notFound } from "next/navigation";
import Link from "next/link";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Field, Form, Notice, Panel, StateChip } from "@/components/ops/ui";
import { getApplication, getChecklist } from "@/lib/applications";
import { listDocuments } from "@/lib/documents";
import { listApplicants } from "@/lib/applicants";
import { opActorForPage } from "@/lib/page-auth";
import { uploadDocumentAction } from "@/app/ops-actions";

export const dynamic = "force-dynamic";

/**
 * Partner upload screen, organised by the file's own checklist: each open item
 * is a card with the instruction that was configured for it, so the agency is
 * told what "good" looks like instead of guessing.
 */
export default async function AgencyDocumentsPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { flash?: string };
}) {
  const actor = await opActorForPage("applications.read");
  let view;
  try {
    ({ view } = await getApplication(actor, params.id));
  } catch {
    notFound();
  }
  const [checklist, documents, applicants] = await Promise.all([
    getChecklist(actor, params.id),
    listDocuments(actor, params.id),
    listApplicants(actor, params.id),
  ]);
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;
  const open = checklist.items.filter((i) => i.isRequired && !i.satisfiedByCurrentDocument);
  const done = checklist.items.filter((i) => i.isRequired && i.satisfiedByCurrentDocument);
  const currentByDoc = new Map(documents.filter((d) => d.isCurrent).map((d) => [d.id, d]));

  return (
    <div className="pb-16">
      <PageHeader
        title={`Documents — ${view.reference}`}
        subtitle={`${view.visaTypeName} · ${view.countryName}`}
        action={
          <Link href={`/agency/applications/${view.id}`} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
            Back to file
          </Link>
        }
      />
      {flash ? (
        <div className="mb-4">
          <Notice kind={searchParams.flash?.startsWith("err") ? "error" : "info"}>{flash}</Notice>
        </div>
      ) : null}
      {view.isTerminal ? (
        <div className="mb-4">
          <Notice kind="warn">This file is closed, so uploads are locked.</Notice>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel
            title="What we still need"
            subtitle={`${checklist.requiredSatisfied} of ${checklist.requiredTotal} required documents accepted. Each traveller needs their own copy where marked.`}
          >
            {!open.length ? (
              <Notice kind="info">Nothing outstanding — the document set is complete. The desk will now review and move the file.</Notice>
            ) : (
              <ul className="space-y-4">
                {open.map((item, idx) => {
                  const existing = item.documentId ? currentByDoc.get(item.documentId) : null;
                  const applicant = item.applicantId ? applicants.find((a) => a.id === item.applicantId) : null;
                  return (
                    <li key={`${item.requirementId}-${idx}`} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-bold text-slate-800">
                          {item.documentTypeName}
                          {applicant ? <span className="ml-2 text-xs font-medium text-slate-500">for {applicant.fullName}</span> : null}
                        </p>
                        <StateChip state={item.state} />
                      </div>
                      {item.instructions ? <p className="mt-1 text-xs leading-relaxed text-slate-500">{item.instructions}</p> : null}
                      {existing?.staffNotes || existing?.rejectionCode ? (
                        <p className="mt-2 rounded bg-amber-50 p-2 text-[11px] text-amber-900">
                          {existing.staffNotes ?? `Rejected (${existing.rejectionCode}) — please replace.`}
                        </p>
                      ) : null}
                      <form action={uploadDocumentAction} className="mt-3 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2">
                        <input type="hidden" name="__applicationId" value={view.id} />
                        <input type="hidden" name="__back" value={`/agency/applications/${view.id}/documents`} />
                        <input type="hidden" name="documentTypeCode" value={item.documentTypeCode} />
                        {item.applicantId ? <input type="hidden" name="applicantId" value={item.applicantId} /> : null}
                        <Field
                          as="file"
                          name="file"
                          label="Choose file"
                          required
                          accept={(item.allowedExtensions?.length ? item.allowedExtensions : ["pdf", "jpg", "png"]).map((e) => `.${e}`).join(",")}
                          hint={item.maxFileSizeMb ? `PDF, PNG, JPEG or WebP · max ${item.maxFileSizeMb} MB` : "PDF, PNG, JPEG or WebP"}
                        />
                        <div>
                          <label className="label" htmlFor={`n-${idx}`}>Note for the desk (optional)</label>
                          <input id={`n-${idx}`} name="agencyNotes" className="input text-xs" placeholder="anything we should know" />
                        </div>
                        <div className="sm:col-span-2">
                          <button type="submit" className="btn-brand !px-4 !py-2 text-xs">
                            Upload {existing ? "a new version" : "document"}
                          </button>
                        </div>
                      </form>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          {done.length ? (
            <Panel title="Accepted" subtitle="These are in good order — a new upload replaces the version the desk has.">
              <ul className="divide-y divide-slate-100 text-sm">
                {done.map((item, idx) => {
                  const doc = item.documentId ? currentByDoc.get(item.documentId) : null;
                  const applicant = item.applicantId ? applicants.find((a) => a.id === item.applicantId) : null;
                  return (
                    <li key={`${item.requirementId}-${idx}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <span className="flex items-center gap-2 font-medium text-slate-700">
                        {item.documentTypeName}
                        {applicant ? <span className="text-[11px] font-normal text-slate-500">· {applicant.fullName}</span> : null}
                      </span>
                      <span className="flex items-center gap-2 text-[11px] text-slate-500">
                        {doc ? <Badge tone="green">v{doc.version} accepted</Badge> : null}
                        {doc ? (
                          <a href={`/api/documents/${doc.id}/content`} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                            view
                          </a>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel title="Optional documents" subtitle="Extra evidence can help; it never blocks the file.">
            {checklist.items.filter((i) => !i.isRequired && i.state !== "NOT_APPLICABLE").length ? (
              <ul className="space-y-1.5 text-xs">
                {checklist.items
                  .filter((i) => !i.isRequired)
                  .map((i, idx) => (
                    <li key={idx} className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">{i.documentTypeName}</span>
                      <StateChip state={i.state} />
                    </li>
                  ))}
              </ul>
            ) : (
              <EmptyState title="Nothing optional configured" />
            )}
          </Panel>
          <Panel title="Your travellers" subtitle="Documents are tracked per person.">
            {!applicants.length ? (
              <Notice kind="warn">No traveller on this file yet — add one from the application screen.</Notice>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {applicants.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">{a.fullName}</span>
                    <span className="text-slate-500">{a.documentsAttached} file(s)</span>
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
