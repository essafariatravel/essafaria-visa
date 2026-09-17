import Link from "next/link";
import {
  appendNoteAction,
  assignAction,
  removeApplicantAction,
  transitionAction,
  upsertApplicantAction,
  updateApplicationAction,
} from "@/app/ops-actions";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Field, Form, KeyVal, Money, Notice, Panel, StateChip, StatusChip } from "@/components/ops/ui";
import type { ApplicationView, ChecklistBundle, TimelineEntry, TransitionOption } from "@/lib/applications";
import type { ApplicantView } from "@/lib/applicants";
import type { InvoiceView, WalletView } from "@/lib/billing";
import type { Role } from "@/lib/rbac";

/* ============================================================
 * Application workspace — the detail screen for BOTH portals.
 *
 * One component, two modes, because the same service calls back both: the staff
 * view adds review / assignment / money panels, and the agency view is the same
 * file with those panels absent. Nothing here is a security decision — the
 * service already refused to hand an agency another tenant's data, and every
 * form below is re-authorised on submit.
 * ============================================================ */

export interface WorkspaceProps {
  mode: "staff" | "agency";
  view: ApplicationView;
  checklist: ChecklistBundle;
  applicants: ApplicantView[];
  timeline: TimelineEntry[];
  transitions: TransitionOption[];
  invoice?: InvoiceView | null;
  wallet?: WalletView | null;
  staffOptions?: Array<{ value: string; label: string }>;
  priorityOptions?: Array<{ value: string; label: string }>;
  flash?: string;
  applicantErrors?: string | null;
}

export function ApplicationWorkspace(props: WorkspaceProps) {
  const { mode, view, checklist, applicants, timeline, transitions, invoice, wallet, staffOptions, priorityOptions } = props;
  const isStaff = mode === "staff";
  const detailPath = isStaff ? `/admin/applications/${view.id}` : `/agency/applications/${view.id}`;

  return (
    <div className="pb-16">
      <PageHeader
        title={view.reference}
        subtitle={`${view.visaTypeName} · ${view.countryName} · ${view.agencyName}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip label={view.statusLabel} color={view.statusColor} />
            {view.priorityLabel ? <Badge tone="amber">{view.priorityLabel}</Badge> : null}
            {view.isTerminal ? <Badge tone="slate">closed</Badge> : null}
            <Link href={isStaff ? "/admin/applications" : "/agency/applications"} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100">
              All applications
            </Link>
          </div>
        }
      />

      {props.flash ? <Notice kind="info">{props.flash}</Notice> : null}
      {view.gateOverridden ? (
        <div className="mt-4">
          <Notice kind="warn">
            This file passed a document gate with a staff override. The reason is recorded permanently in the history below.
          </Notice>
        </div>
      ) : null}
      {checklist.configDrifted ? (
        <div className="mt-4">
          <Notice kind="info">
            The requirements for this visa route changed after the file was captured. The checklist still shows what the
            file was told to provide; a re-check freezes the new set for the steps still ahead.
          </Notice>
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="File">
            <KeyVal
              rows={[
                ["Travellers", `${view.applicantCount} of ${view.requestedCount}`],
                ["Travel date", view.travelDate ?? "not set"],
                ["Checklist", `${checklist.requiredSatisfied}/${checklist.requiredTotal} required documents accepted`],
                ["Opened", new Date(view.createdAt).toLocaleDateString()],
                ["Submitted", view.submittedAt ? new Date(view.submittedAt).toLocaleString() : "not yet"],
                ["Last activity", new Date(view.lastActivityAt).toLocaleString()],
                ["Consulate ref", view.consulateRef ?? null],
                ["Case officer", view.caseOfficerName ?? null],
              ]}
            />
            {view.notes ? (
              <p className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">{view.notes}</p>
            ) : null}
            {isStaff && view.staffNotes ? (
              <p className="mt-3 whitespace-pre-wrap rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
                <b className="mr-1 text-[10px] uppercase tracking-wide">Internal:</b>
                {view.staffNotes}
              </p>
            ) : null}
          </Panel>

          <Panel
            title="Travellers"
            subtitle="Each applicant's own documents are tracked per requirement — one passport never covers the group."
            action={
              <details className="relative">
                <summary className="cursor-pointer list-none rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                  Add traveller
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-[min(92vw,560px)] rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
                  <ApplicantForm applicationId={view.id} back={detailPath} />
                </div>
              </details>
            }
          >
            {!applicants.length ? (
              <EmptyState title="No travellers yet" hint="Add the first applicant to open their document checklist." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {applicants.map((a) => (
                  <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                          {a.fullName}
                          {a.isPrimary ? <Badge tone="navy">primary</Badge> : null}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          {[a.passportNumber && `passport ${a.passportNumber}`, a.nationality, a.dateOfBirth && `born ${a.dateOfBirth}`]
                            .filter(Boolean)
                            .join(" · ") || "identity not filled in yet"}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          {a.passportExpiryDate ? `passport expires ${a.passportExpiryDate}` : "no passport expiry recorded"} ·{" "}
                          {a.documentsAttached} document{a.documentsAttached === 1 ? "" : "s"} on file
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <details>
                          <summary className="cursor-pointer list-none rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                            Edit
                          </summary>
                          <div className="fixed inset-x-4 top-10 z-30 mx-auto max-h-[85vh] max-w-2xl overflow-auto rounded-xl border border-slate-200 bg-white p-4 shadow-2xl md:inset-auto md:right-8 md:top-16 md:w-[620px]">
                            <p className="mb-3 text-sm font-bold">Edit {a.fullName}</p>
                            <ApplicantForm applicationId={view.id} back={detailPath} applicant={a} />
                          </div>
                        </details>
                        <form action={removeApplicantAction} className="inline">
                          <input type="hidden" name="__applicationId" value={view.id} />
                          <input type="hidden" name="__applicantId" value={a.id} />
                          <input type="hidden" name="__back" value={detailPath} />
                          <button type="submit" className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50">
                            Remove
                          </button>
                        </form>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {props.applicantErrors ? (
              <div className="mt-3">
                <Notice kind="error">{props.applicantErrors}</Notice>
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Document checklist"
            subtitle={`Derived live from this file's requirement snapshot — ${checklist.complete ? "complete" : `${checklist.blocking.length} item(s) outstanding`}.`}
            action={
              isStaff ? (
                <span className="flex items-center gap-2">
                  <Link href={`/admin/applications/${view.id}/assistant`} className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100">
                    AI assist
                  </Link>
                  <Link href={`/admin/applications/${view.id}/documents`} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                    Document desk
                  </Link>
                </span>
              ) : (
                <Link href={`/agency/applications/${view.id}/documents`} className="btn-brand !px-3 !py-1.5 text-xs">
                  Upload documents
                </Link>
              )
            }
          >
            <ChecklistTable items={checklist.items} />
          </Panel>

          <Panel title="History" subtitle={isStaff ? "Every status move, document decision, override, note and payment." : "Updates ESSAFARIA chose to share with you."}>
            {!timeline.length ? (
              <EmptyState title="Nothing recorded yet" />
            ) : (
              <ol className="space-y-3">
                {timeline.map((e) => (
                  <li key={e.id} className="flex gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--color-brand-primary)]" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-800">
                        {e.message ?? e.type.replace(/_/g, " ").toLowerCase()}
                        {e.toStatusCode ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">{e.toStatusCode}</span> : null}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {new Date(e.createdAt).toLocaleString()} · {e.actorEmail ?? (e.actorKind === "AUTOMATION" ? "automation" : e.actorKind.toLowerCase())}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div>
          <Panel title="Workflow">
            {!transitions.length ? (
              <Notice kind="info">No further step is available from “{view.statusLabel}”.</Notice>
            ) : (
              <ul className="space-y-2">
                {transitions.map((o) => (
                  <li key={o.code}>
                    <form action={transitionAction} className="rounded-lg border border-slate-200 p-3">
                      <input type="hidden" name="__applicationId" value={view.id} />
                      <input type="hidden" name="__back" value={detailPath} />
                      <input type="hidden" name="toStatusCode" value={o.code} />
                      <div className="flex items-center justify-between gap-2">
                        <StatusChip label={o.label} color={o.color} />
                        {o.requiresDocumentsComplete ? <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">gate</span> : null}
                      </div>
                      {o.blockedReason ? (
                        <p className="mt-2 text-[11px] leading-snug text-red-700">{o.blockedReason}</p>
                      ) : null}
                      {o.overridable ? (
                        <>
                          <label className="mt-2 block text-[11px] font-semibold text-slate-600" htmlFor={`reason-${o.code}`}>
                            Override reason (mandatory, min 20 chars)
                          </label>
                          <textarea id={`reason-${o.code}`} name="reason" rows={3} className="input mt-1 text-xs" placeholder="Why is this file moving without a clean checklist?" />
                          <input type="hidden" name="forceOverride" value="1" />
                        </>
                      ) : !o.blockedReason ? (
                        <label className="mt-2 block text-[11px] text-slate-500" htmlFor={`note-${o.code}`}>
                          Note (optional, shared with the agency)
                        </label>
                      ) : null}
                      {!o.overridable && !o.blockedReason ? (
                        <>
                          <input id={`note-${o.code}`} name="reason" className="input mt-1 text-xs" placeholder="optional note" />
                          <button type="submit" className="btn-brand mt-2 w-full !px-3 !py-1.5 text-xs">
                            Move to {o.label}
                          </button>
                        </>
                      ) : null}
                      {o.overridable ? (
                        <button type="submit" className="mt-2 w-full rounded-md border border-amber-300 bg-amber-50 !px-3 !py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100">
                          Override gate
                        </button>
                      ) : null}
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Messages" subtitle={isStaff ? "Internal notes stay internal; tick “share with agency” to send it into their history." : "Anything the desk shares with you appears here."}>
            <Form action={appendNoteAction} submitLabel={isStaff ? "Add note" : "Send message"} back={detailPath} applicationId={view.id}>
              <Field as="textarea" name="body" label={isStaff ? "Note" : "Message to ESSAFARIA"} rows={4} required />
              {isStaff ? <Field as="checkbox" name="customerVisible" label="Share with agency" defaultValue={false} hint="Visible in the agency's history" /> : <input type="hidden" name="customerVisible" value="on" />}
            </Form>
          </Panel>

          {isStaff ? (
            <Panel title="Assignment">
              <Form action={assignAction} submitLabel="Assign" back={detailPath} applicationId={view.id}>
                <Field as="select" name="userId" label="Case officer" options={staffOptions ?? []} defaultValue={undefined} hint="Only active staff can hold a file" />
              </Form>
              <Form action={updateApplicationAction} submitLabel="Save internal fields" back={detailPath} applicationId={view.id}>
                <Field name="consulateRef" label="Consulate reference" defaultValue={view.consulateRef ?? ""} />
                <Field as="textarea" name="staffNotes" label="Internal notes" rows={3} defaultValue={view.staffNotes ?? ""} />
              </Form>
            </Panel>
          ) : null}

          <Panel title="Billing" subtitle={invoice ? `Invoice ${invoice.number} · ${invoice.status.toLowerCase().replace("_", " ")}` : "No invoice yet — pricing is frozen when the file is captured."}>
            {invoice ? (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="th">Line</th>
                      <th className="th text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.items.map((i) => (
                      <tr key={i.id} className="border-t border-slate-100">
                        <td className="td">
                          {i.description}
                          {i.quantity > 1 ? <span className="text-slate-400"> × {i.quantity}</span> : null}
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">{i.chargeStatus}</span>
                        </td>
                        <td className="td text-right">
                          <Money cents={i.amountCents} code={invoice.currencyCode} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 font-bold">
                      <td className="td">Total</td>
                      <td className="td text-right">
                        <Money cents={invoice.subtotalCents} code={invoice.currencyCode} />
                      </td>
                    </tr>
                    <tr>
                      <td className="td text-slate-500">Paid from wallet</td>
                      <td className="td text-right text-slate-500">
                        <Money cents={invoice.paidCents} code={invoice.currencyCode} />
                      </td>
                    </tr>
                    {invoice.balanceDueCents > 0 ? (
                      <tr>
                        <td className="td text-red-700">Outstanding</td>
                        <td className="td text-right font-semibold text-red-700">
                          <Money cents={invoice.balanceDueCents} code={invoice.currencyCode} />
                        </td>
                      </tr>
                    ) : null}
                  </tfoot>
                </table>
                {wallet ? (
                  <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    Agency wallet balance: <b className="tabular-nums"><Money cents={wallet.balanceCents} code={wallet.currencyCode} /></b>
                    {wallet.consistent ? null : <span className="ml-2 font-semibold text-red-700">ledger mismatch</span>}
                  </p>
                ) : null}
              </>
            ) : (
              <EmptyState title="Nothing billed yet" hint="Pricing is frozen on the file and invoiced when it is submitted." />
            )}
          </Panel>

          {isStaff ? (
            <Panel title="Travellers & headcount" subtitle="Changing the headcount or priority re-prices the file for the steps still ahead — issued invoices are never rewritten once money has moved.">
              <Form action={updateApplicationAction} submitLabel="Update file" back={detailPath} applicationId={view.id}>
                <Field name="requestedCount" type="number" label="Requested travellers" defaultValue={view.requestedCount} hint="1–50; cannot be below the applicants on file" />
                <Field as="select" name="priorityId" label="Priority" options={priorityOptions ?? []} />
                <Field name="travelDate" type="date" label="Travel date" defaultValue={view.travelDate ?? ""} />
                <Field as="textarea" name="notes" label="Agency-visible note" rows={3} defaultValue={view.notes ?? ""} />
              </Form>
            </Panel>
          ) : (
            <Panel title="Your file details">
              <Notice kind="info">
                {view.statusCode === "NEW"
                  ? "While the file is still at intake you can edit travellers and upload documents freely."
                  : "The desk is working on this file. Ask them to send it back if something needs changing."}
              </Notice>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function ChecklistTable({ items }: { items: ChecklistBundle["items"] }) {
  if (!items.length) {
    return <EmptyState title="No requirements configured" hint="This visa route has no checklist defined yet, so nothing is required." />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr>
            <th className="th">Document</th>
            <th className="th">Who</th>
            <th className="th">State</th>
            <th className="th text-right">Version</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i, idx) => (
            <tr key={`${i.requirementId}-${i.applicantId ?? "app"}-${idx}`} className="border-t border-slate-100 align-top">
              <td className="td">
                <p className="font-semibold text-slate-800">
                  {i.documentTypeName}
                  {i.isRequired ? null : <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">optional</span>}
                </p>
                {i.instructions ? <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-slate-500">{i.instructions}</p> : null}
              </td>
              <td className="td text-xs text-slate-500">{i.applicantId ? "per traveller" : "one for the file"}</td>
              <td className="td">
                <StateChip state={i.state} />
              </td>
              <td className="td text-right text-xs tabular-nums text-slate-500">
                {i.documentId ? (
                  <a href={`/api/documents/${i.documentId}/content`} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                    {i.documentVersion ? `v${i.documentVersion}` : "open"}
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApplicantForm({
  applicationId,
  back,
  applicant,
}: {
  applicationId: string;
  back: string;
  applicant?: ApplicantView;
}) {
  return (
    <Form
      action={upsertApplicantAction}
      submitLabel={applicant ? "Save traveller" : "Add traveller"}
      back={back}
      applicationId={applicationId}
    >
      {applicant ? <input type="hidden" name="__applicantId" value={applicant.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="fullName" label="Full name (as in passport)" required defaultValue={applicant?.fullName ?? ""} />
        <Field name="dateOfBirth" type="date" label="Date of birth" required defaultValue={applicant?.dateOfBirth ?? ""} />
        <Field as="select" name="gender" label="Gender" options={[{ value: "MALE", label: "Male" }, { value: "FEMALE", label: "Female" }, { value: "OTHER", label: "Other" }]} defaultValue={applicant?.gender ?? ""} />
        <Field name="nationalityCountryCode" label="Nationality (ISO code)" hint="e.g. DZ — validated against configured countries" defaultValue={applicant?.nationality ?? ""} />
        <Field name="passportNumber" label="Passport number" defaultValue={applicant?.passportNumber ?? ""} />
        <Field name="passportExpiryDate" type="date" label="Passport expiry" required defaultValue={applicant?.passportExpiryDate ?? ""} />
        <Field name="passportIssueDate" type="date" label="Passport issue date" defaultValue="" />
        <Field name="intendedEntryDate" type="date" label="Intended entry" defaultValue={applicant?.intendedEntryDate ?? ""} />
        <Field name="intendedExitDate" type="date" label="Intended exit" defaultValue={applicant?.intendedExitDate ?? ""} />
        <Field name="email" type="email" label="Email" defaultValue={applicant?.email ?? ""} />
        <Field name="phone" label="Phone" defaultValue={applicant?.phone ?? ""} />
        <Field as="textarea" name="address" label="Address" rows={2} defaultValue={applicant?.address ?? ""} />
      </div>
    </Form>
  );
}
