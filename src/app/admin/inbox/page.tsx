import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Field, Form, Notice, Panel, StateChip } from "@/components/ops/ui";
import { getDb, gmailMessages, visaApplications, applicationStatuses } from "@/db";
import { gmailStatus, listConnections, listInboundQueue } from "@/lib/gmail";
import { staffActorForPage } from "@/lib/page-auth";
import { can } from "@/lib/rbac";
import { getSetting } from "@/lib/config-service";
import { documentTypeOptions } from "@/lib/options";
import { listApplicants } from "@/lib/applicants";
import {
  createConnectionAction,
  disconnectMailboxAction,
  dismissMessageAction,
  draftReplyAction,
  linkAttachmentAction,
  startConnectAction,
  syncMailboxAction,
} from "@/app/admin/gmail-actions";

export const dynamic = "force-dynamic";

type Q = any;

/**
 * Gmail intake desk. Inbound email is treated as untrusted input: it is
 * classified, matched and staged, and it changes a file only when a person
 * links an attachment — which then runs the ordinary upload pipeline.
 */
export default async function AdminInboxPage({
  searchParams,
}: {
  searchParams: { flash?: string; message?: string; only?: string };
}) {
  const actor = await staffActorForPage("communications.read");
  const mayManage = can(actor.role, "gmail.manage");
  const mayReview = can(actor.role, "applications.review");
  const [connections, queue, status, enabled, types] = await Promise.all([
    listConnections(actor),
    listInboundQueue(actor, { onlyUnreviewed: searchParams.only !== "all", limit: 40 }),
    Promise.resolve(gmailStatus()),
    getSetting<boolean>("gmail.enabled", false),
    documentTypeOptions(),
  ]);
  const selected = searchParams.message
    ? (await ((await getDb()) as Q)
        .select({
          id: gmailMessages.id,
          subject: gmailMessages.subject,
          fromAddress: gmailMessages.fromAddress,
          bodyText: gmailMessages.bodyText,
          receivedAt: gmailMessages.receivedAt,
          classification: gmailMessages.classification,
          matchedBy: gmailMessages.matchedBy,
          matchConfidence: gmailMessages.matchConfidence,
          reference: visaApplications.reference,
          applicationId: visaApplications.id,
        })
        .from(gmailMessages)
        .leftJoin(visaApplications, eq(visaApplications.id, gmailMessages.matchedApplicationId))
        .where(eq(gmailMessages.id, searchParams.message))
        .limit(1))[0]
    : null;
  const applicants = selected?.applicationId ? await listApplicants(actor, selected.applicationId).catch(() => []) : [];
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;
  const t: Q = await getDb();
  const openFiles = (await t
    .select({ n: sql<number>`count(*)::int` })
    .from(visaApplications)
    .innerJoin(applicationStatuses, eq(applicationStatuses.id, visaApplications.statusId))
    .where(eq(applicationStatuses.isTerminal, false))) as Array<{ n: number }>;

  return (
    <div>
      <PageHeader
        title="Gmail intake"
        subtitle="Messages are classified and matched automatically, attachments are staged for a person, and nothing is ever sent from this screen — reply drafts land in the mailbox for a human to review."
        action={
          <Link href={`/admin/inbox?only=${searchParams.only === "all" ? "" : "all"}`} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
            {searchParams.only === "all" ? "Unreviewed only" : "Show all"}
          </Link>
        }
      />
      {flash ? (
        <div className="mb-4">
          <Notice kind={searchParams.flash?.startsWith("err") ? "error" : "info"}>{flash}</Notice>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Provider</p>
          <p className="mt-1 text-lg font-black">{status.provider}</p>
          <p className="text-[11px] text-slate-400">{status.available ? "adapter available" : "no adapter configured"}</p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Intake switch</p>
          <p className="mt-1 text-lg font-black">{enabled ? "enabled" : "disabled"}</p>
          <p className="text-[11px] text-slate-400">
            Settings → Gmail · <span className="font-semibold">gmail.enabled</span>
          </p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Token encryption</p>
          <p className="mt-1 text-lg font-black">{status.tokenKeyConfigured ? "ready" : "not configured"}</p>
          <p className="text-[11px] text-slate-400">ESF_TOKEN_KEY (32-byte base64) seals refresh tokens</p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Queue</p>
          <p className="mt-1 text-lg font-black">{queue.length}</p>
          <p className="text-[11px] text-slate-400">awaiting review · {Number(openFiles[0]?.n ?? 0)} open files</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel title="Inbound queue" subtitle="Stored first, acted on only by a person.">
            {!queue.length ? (
              <EmptyState title="Nothing waiting" hint="Sync a mailbox, or lower the review filter." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {queue.map((row) => (
                  <li key={row.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                          <Link href={`/admin/inbox?message=${row.id}`} className="hover:underline">
                            {row.subject ?? "(no subject)"}
                          </Link>
                          {row.classification ? <Badge tone={row.classification === "SPAM" ? "red" : "navy"}>{row.classification.toLowerCase()}</Badge> : null}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          {row.fromAddress ?? "unknown sender"} · {row.receivedAt ? new Date(row.receivedAt).toLocaleString() : "no date"} · matched by{" "}
                          {(row.matchedBy ?? "none").toLowerCase()}
                          {row.confidence ? ` · rule confidence ${row.confidence}%` : ""}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs text-slate-600">{row.bodyPreview}</p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {row.reference ? (
                            <>
                              file <b className="font-mono">{row.reference}</b>
                            </>
                          ) : (
                            <span className="italic text-slate-400">no file matched</span>
                          )}
                          {row.agencyName ? ` · ${row.agencyName}` : ""} · {row.attachments.length} attachment(s)
                        </p>
                      </div>
                      {mayReview ? (
                        <form action={dismissMessageAction} className="flex shrink-0 flex-col gap-1">
                          <input type="hidden" name="messageId" value={row.id} />
                          <input name="note" className="input !w-40 !py-1 text-[11px]" placeholder="why (optional)" />
                          <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                            Not for us
                          </button>
                        </form>
                      ) : null}
                    </div>
                    {row.attachments.length ? (
                      <ul className="mt-2 space-y-1">
                        {row.attachments.map((a) => (
                          <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[11px]">
                            <span className="font-semibold text-slate-700">{a.filename}</span>
                            <span className="text-slate-500">{(a.sizeBytes / 1024).toFixed(0)} KB</span>
                            {a.suggested ? <Badge tone="navy">suggests {a.suggested}</Badge> : <Badge tone="slate">type unclear</Badge>}
                            {a.linked ? (
                              <span className="flex items-center gap-1 text-emerald-700">
                                <StateChip state="ACCEPTED" /> linked
                              </span>
                            ) : (
                              <span className="text-slate-400">staged — not attached to any file yet</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {selected ? (
            <Panel title={`Message — ${selected.subject ?? "(no subject)"}`} subtitle={`${selected.fromAddress ?? "unknown"} · ${selected.matchedBy ?? "unmatched"}${selected.matchConfidence ? ` · confidence ${selected.matchConfidence}%` : ""}`}>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs leading-relaxed">{String(selected.bodyText ?? "")}</pre>
              <p className="mt-2 text-[11px] text-slate-400">
                HTML was discarded on import (only the plain-text part is stored), so nothing in this message can mark up the desk.
              </p>
              {selected.applicationId ? (
                <p className="mt-2 text-xs">
                  <Link href={`/admin/applications/${selected.applicationId}`} className="font-semibold text-[var(--color-brand-primary)] hover:underline">
                    Open {selected.reference}
                  </Link>
                </p>
              ) : null}
              {mayReview ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Link an attachment to a file</p>
                    <Form action={linkAttachmentAction} submitLabel="Attach to file" back={`/admin/inbox?message=${selected.id}`}>
                      <Field name="attachmentId" label="Attachment row id" required hint="shown in the queue entry above" />
                      <Field name="applicationId" label="Application id" required defaultValue={selected.applicationId ?? ""} />
                      <Field as="select" name="documentTypeCode" label="Document type" options={types.map((x) => ({ value: x.code, label: x.label }))} required />
                      {applicants.length ? (
                        <Field as="select" name="applicantId" label="Traveller" options={applicants.map((a) => ({ value: a.id, label: a.fullName }))} />
                      ) : null}
                    </Form>
                    <p className="mt-2 text-[10px] leading-snug text-slate-400">
                      Runs the full upload pipeline: tenant proof, content sniffing, checklist rules, dedupe, event, audit. A repeat click creates nothing twice.
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Draft a reply</p>
                    <Form action={draftReplyAction} submitLabel="Create draft in mailbox" back={`/admin/inbox?message=${selected.id}`}>
                      <input type="hidden" name="messageId" value={selected.id} />
                      <Field as="textarea" name="body" label="Reply body" rows={7} required hint="Stored as a Gmail draft — never sent automatically" />
                    </Form>
                  </div>
                </div>
              ) : null}
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel title="Mailboxes">
            {!connections.length ? (
              <EmptyState title="No mailbox registered" />
            ) : (
              <ul className="space-y-3">
                {connections.map((c) => (
                  <li key={c.id} className="rounded-lg border border-slate-200 p-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                      {c.label}
                      <Badge tone={c.status === "CONNECTED" ? "green" : c.status === "ERROR" ? "red" : "slate"}>{c.status.toLowerCase()}</Badge>
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {c.emailAddress ?? "address not confirmed"} · provider {c.provider}
                      {c.tokenStored ? " · token stored (sealed)" : " · no token"}
                    </p>
                    {c.lastError ? <p className="mt-1 text-[11px] text-red-700">last error: {c.lastError}</p> : null}
                    {c.lastSyncAt ? <p className="mt-1 text-[10px] text-slate-400">last sync {new Date(c.lastSyncAt).toLocaleString()}</p> : null}
                    {mayManage ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <form action={startConnectAction}>
                          <input type="hidden" name="connectionId" value={c.id} />
                          <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100">
                            Connect
                          </button>
                        </form>
                        <form action={syncMailboxAction}>
                          <input type="hidden" name="connectionId" value={c.id} />
                          <button type="submit" className="btn-brand !px-2 !py-1 text-[11px]">
                            Sync now
                          </button>
                        </form>
                        <form action={disconnectMailboxAction}>
                          <input type="hidden" name="connectionId" value={c.id} />
                          <button type="submit" className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50">
                            Disconnect
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {mayManage ? (
            <Panel title="Register a mailbox" subtitle="Only the address and a label are stored; OAuth secrets live in named environment variables.">
              <Form action={createConnectionAction} submitLabel="Register" back="/admin/inbox">
                <Field name="label" label="Label" required placeholder="Visa desk inbox" />
                <Field name="emailAddress" type="email" label="Mailbox address" required />
              </Form>
            </Panel>
          ) : null}

          <Panel title="What this integration will not do">
            <ul className="list-disc space-y-1.5 pl-4 text-xs text-slate-600">
              <li>send anything — drafts only</li>
              <li>change a fee, status, requirement or priority from email text</li>
              <li>attach a document to a file without a staff click</li>
              <li>store HTML, tokens, or secrets in the database or the audit log</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
