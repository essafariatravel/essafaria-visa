import { asc, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import {
  agencies,
  currencies,
  getDb,
  invoiceItems,
  invoices,
} from "@/db";
import { Badge, EmptyState, PageHeader } from "@/components/admin/ui";
import { Field, Form, Money, Notice, Panel, StateChip } from "@/components/ops/ui";
import { getWallet, listWalletLedger, reconcileWallets } from "@/lib/billing";
import { deliveryStats } from "@/lib/notifications";
import { staffActorForPage } from "@/lib/page-auth";
import { can } from "@/lib/rbac";
import { adjustWalletAction, creditWalletAction, drainOutboxAction, reverseChargeAction, voidInvoiceAction } from "@/app/admin/wallet-actions";
import { getSetting } from "@/lib/config-service";

export const dynamic = "force-dynamic";

type Q = any;

/**
 * The money desk: balances, funding, adjustments, reversals and a live ledger
 * reconciliation. Nothing here trusts the browser: amounts are converted to
 * integer cents, the capability is re-checked in the service, and each write
 * moves the header conditionally inside the same transaction as the ledger row.
 */
export default async function AdminWalletPage({
  searchParams,
}: {
  searchParams: { agency?: string; flash?: string };
}) {
  const actor = await staffActorForPage("wallet.read");
  const mayFund = can(actor.role, "wallet.write");
  const t: Q = await getDb();
  const agencyRows = (await t
    .select({
      id: agencies.id,
      code: agencies.code,
      name: agencies.name,
      status: agencies.status,
      balance: agencies.walletBalanceCents,

    })
    .from(agencies)
    .orderBy(asc(agencies.name))) as unknown as Array<{ id: string; code: string; name: string; status: string; balance: number; openFiles: number }>;
  const counts = (await t
    .select({ id: agencies.id, n: sql<number>`(select count(*) from visa_applications where agency_id = agencies.id)::int` })
    .from(agencies)) as Array<{ id: string; n: number }>;
  const countById = new Map(counts.map((c) => [c.id, Number(c.n)]));

  const selected = searchParams.agency ?? agencyRows[0]?.id ?? null;
  const [selectedAgency] = selected
    ? ((await t.select().from(agencies).where(eq(agencies.id, selected)).limit(1)) as Array<Record<string, any>>)
    : [];
  const wallet = selected ? await getWallet(selected) : null;
  const ledger = selected ? await listWalletLedger(selected, { limit: 40 }) : { rows: [], total: 0 };
  const recon = await reconcileWallets();
  const mismatches = recon.filter((r) => !r.consistent);
  const invRows = selected
    ? ((await t
        .select()
        .from(invoices)
        .where(eq(invoices.agencyId, selected))
        .orderBy(desc(invoices.createdAt))
        .limit(25)) as Array<typeof invoices.$inferSelect>)
    : [];
  const items = invRows.length
    ? ((await t
        .select()
        .from(invoiceItems)
        .where(sql`${invoiceItems.invoiceId} in (${sql.join(invRows.map((i) => sql`${i.id}`), sql`,`)})`)) as Array<typeof invoiceItems.$inferSelect>)
    : [];
  const currencyRows = (await t
    .select({ code: currencies.code, symbol: currencies.symbol })
    .from(currencies)
    .where(eq(currencies.isActive, true))) as Array<{ code: string; symbol: string }>;
  const lowThreshold = Number(await getSetting<number>("ops.walletLowBalanceThresholdCents", 0));
  const deliveries = await deliveryStats();
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;

  return (
    <div>
      <PageHeader
        title="Agency wallets"
        subtitle="Prepaid balances funded manually by ESSAFARIA. There is no online payment gateway: a top-up is recorded here when the money actually arrives."
      />
      {flash ? (
        <div className="mb-4">
          <Notice kind={searchParams.flash?.startsWith("err") ? "error" : "info"}>{flash}</Notice>
        </div>
      ) : null}

      {mismatches.length ? (
        <div className="mb-4">
          <Notice kind="error">
            Ledger mismatch on {mismatches.length} agency account(s): {mismatches.map((m) => m.agencyCode).join(", ")}. The header and the sum of
            transactions disagree — investigate before charging anything.
          </Notice>
        </div>
      ) : (
        <div className="mb-4">
          <Notice kind="info">Ledger reconciles: for every agency, the recorded balance equals the sum of its transactions.</Notice>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {agencyRows.slice(0, 8).map((a) => {
          const low = Number(a.balance) < lowThreshold;
          return (
            <Link
              key={a.id}
              href={`/admin/wallet?agency=${a.id}`}
              className={`card block p-4 transition-shadow hover:shadow-md ${selected === a.id ? "ring-2 ring-[var(--color-brand-primary)]" : ""}`}
            >
              <p className={`text-xl font-black tabular-nums ${low ? "text-red-600" : ""}`} style={low ? undefined : { color: "var(--color-brand-primary)" }}>
                <Money cents={Number(a.balance)} code="EUR" />
              </p>
              <p className="mt-1 truncate text-xs font-semibold text-slate-700">{a.name}</p>
              <p className="text-[11px] text-slate-400">
                {a.code} · {countById.get(a.id) ?? 0} file{countById.get(a.id) === 1 ? "" : "s"}
                {low ? " · below alert level" : ""}
              </p>
            </Link>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {selectedAgency ? (
            <>
              <Panel title={`Ledger — ${selectedAgency.name}`} subtitle={`${ledger.total} transaction(s). Append-only: corrections are new rows that point at what they fix.`}>
                {!ledger.rows.length ? (
                  <EmptyState title="No movements yet" />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="th">When</th>
                        <th className="th">Type</th>
                        <th className="th">Why</th>
                        <th className="th text-right">Amount</th>
                        <th className="th text-right">Balance</th>
                        {mayFund ? <th className="th" /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.rows.map((r) => (
                        <tr key={r.id} className="border-t border-slate-100 align-top">
                          <td className="td text-[11px] text-slate-500">{new Date(r.occurredAt).toLocaleString()}</td>
                          <td className="td">
                            <Badge tone={r.kind === "CREDIT" ? "green" : r.kind === "DEBIT" ? "navy" : "amber"}>{r.kind.toLowerCase()}</Badge>
                          </td>
                          <td className="td">
                            <p className="text-xs text-slate-700">{r.reason}</p>
                            {r.referenceLabel ? (
                              <p className="text-[11px]">
                                <Link href={`/admin/applications/${r.applicationId}`} className="font-mono text-[var(--color-brand-primary)] hover:underline">
                                  {r.referenceLabel}
                                </Link>
                              </p>
                            ) : null}
                            {r.reference ? <p className="text-[10px] text-slate-400">ref {r.reference}</p> : null}
                            {r.actorEmail ? <p className="text-[10px] text-slate-400">by {r.actorEmail}</p> : null}
                          </td>
                          <td className={`td text-right font-semibold tabular-nums ${r.amountCents < 0 ? "text-red-700" : "text-emerald-700"}`}>
                            {r.amountCents < 0 ? "−" : "+"}
                            <Money cents={Math.abs(r.amountCents)} code={r.currencyCode} />
                          </td>
                          <td className="td text-right tabular-nums text-slate-500">
                            <Money cents={r.balanceAfterCents} code={r.currencyCode} />
                          </td>
                          {mayFund ? (
                            <td className="td text-right">
                              {r.kind === "DEBIT" || r.kind === "CREDIT" || r.kind === "ADJUSTMENT" ? (
                                <details>
                                  <summary className="cursor-pointer text-[11px] font-semibold text-red-700">reverse</summary>
                                  <form action={reverseChargeAction} className="mt-2 flex flex-col gap-1">
                                    <input type="hidden" name="walletTxId" value={r.id} />
                                    <input type="hidden" name="__back" value={`/admin/wallet?agency=${selected}`} />
                                    <input name="reason" className="input !w-52 !py-1 text-[11px]" placeholder="reason (required)" required minLength={5} />
                                    <button type="submit" className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50">
                                      Confirm reversal
                                    </button>
                                  </form>
                                </details>
                              ) : null}
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>

              <Panel title="Invoices" subtitle="Raised from the file's frozen pricing. Void is only possible while nothing has been collected.">
                {!invRows.length ? (
                  <EmptyState title="No invoices for this agency" />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {invRows.map((inv) => {
                      const lines = items.filter((i) => i.invoiceId === inv.id);
                      const due = Number(inv.subtotalCents) - Number(inv.paidCents);
                      return (
                        <li key={inv.id} className="py-3 first:pt-0 last:pb-0">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-mono text-xs font-bold text-slate-700">{inv.number}</p>
                              <p className="text-[11px] text-slate-500">
                                {inv.applicationId ? (
                                  <Link href={`/admin/applications/${inv.applicationId}`} className="hover:underline">
                                    open file
                                  </Link>
                                ) : null}
                                {inv.voidReason ? ` · voided: ${inv.voidReason}` : ""}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge tone={inv.status === "PAID" ? "green" : inv.status === "VOID" ? "slate" : "amber"}>{inv.status.toLowerCase().replace(/_/g, " ")}</Badge>
                              <span className="text-sm font-bold tabular-nums">
                                <Money cents={Number(inv.subtotalCents)} code={inv.currencyCode} />
                              </span>
                            </div>
                          </div>
                          <ul className="mt-2 space-y-1">
                            {lines.map((l) => (
                              <li key={l.id} className="flex items-center justify-between text-[11px] text-slate-600">
                                <span>
                                  {l.description}
                                  {l.quantity > 1 ? ` ×${l.quantity}` : ""}
                                </span>
                                <span className="flex items-center gap-2">
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase">{l.chargeStatus}</span>
                                  <Money cents={Number(l.amountCents)} code={inv.currencyCode} />
                                </span>
                              </li>
                            ))}
                          </ul>
                          {due > 0 && inv.status !== "VOID" && mayFund ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="text-[11px] font-semibold text-red-700">
                                Outstanding <Money cents={due} code={inv.currencyCode} />
                              </span>
                              {inv.applicationId ? (
                                <Link href={`/admin/applications/${inv.applicationId}`} className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                                  charge from wallet
                                </Link>
                              ) : null}
                              <details>
                                <summary className="cursor-pointer text-[11px] font-semibold text-slate-500">void invoice</summary>
                                <form action={voidInvoiceAction} className="mt-1 flex items-end gap-2">
                                  <input type="hidden" name="invoiceId" value={inv.id} />
                                  <input type="hidden" name="__back" value={`/admin/wallet?agency=${selected}`} />
                                  <input name="reason" className="input !w-56 !py-1 text-[11px]" placeholder="reason" required minLength={5} />
                                  <button type="submit" className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-700">
                                    Void
                                  </button>
                                </form>
                              </details>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            </>
          ) : (
            <Panel title="No agency selected">
              <EmptyState title="Create an agency first" hint="Wallets belong to agencies; add one under Agencies." />
            </Panel>
          )}
        </div>

        <div className="space-y-6">
          {mayFund && selectedAgency ? (
            <Panel title="Add balance" subtitle="Recorded as a manual credit with the bank reference and the person who keyed it.">
              <Form action={creditWalletAction} submitLabel="Record credit" back="/admin/wallet">
                <input type="hidden" name="agencyId" value={String(selected)} />
                <Field name="amount" label="Amount (e.g. 2500 or 250.50)" required hint="Converted to whole cents — never stored as a float" />
                <Field as="select" name="currencyCode" label="Currency" options={currencyRows.map((c) => ({ value: c.code, label: `${c.code} ${c.symbol}` }))} defaultValue="EUR" required />
                <Field name="reference" label="Bank reference" />
                <Field as="textarea" name="reason" label="Reason" rows={2} required />
                <Field name="idempotencyKey" label="Idempotency key" hint="same key twice = one credit, even across retries" />
              </Form>
            </Panel>
          ) : null}

          {mayFund && selectedAgency ? (
            <Panel title="Refund or adjustment" subtitle="A negative adjustment is refused unless Settings → Operations allows a negative balance.">
              <Form action={adjustWalletAction} submitLabel="Record adjustment" back="/admin/wallet">
                <input type="hidden" name="agencyId" value={String(selected)} />
                <input type="hidden" name="currencyCode" value="EUR" />
                <Field name="amount" label="Amount (use a minus for a debit)" required />
                <Field
                  as="select"
                  name="kind"
                  label="Kind"
                  defaultValue="ADJUSTMENT"
                  options={[
                    { value: "ADJUSTMENT", label: "Adjustment" },
                    { value: "REFUND", label: "Refund (always credited)" },
                  ]}
                />
                <Field as="textarea" name="reason" label="Reason" rows={2} required />
              </Form>
            </Panel>
          ) : null}

          <Panel title="Reconciliation" subtitle="Header balance against the sum of the ledger, for every agency.">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="th">Agency</th>
                  <th className="th text-right">Header</th>
                  <th className="th text-right">Ledger sum</th>
                  <th className="th">OK</th>
                </tr>
              </thead>
              <tbody>
                {recon.map((r) => (
                  <tr key={r.agencyId} className="border-t border-slate-100">
                    <td className="td font-semibold text-slate-700">{r.agencyCode}</td>
                    <td className="td text-right tabular-nums">{(r.balanceCents / 100).toFixed(2)}</td>
                    <td className="td text-right tabular-nums">{(r.ledgerSumCents / 100).toFixed(2)}</td>
                    <td className="td">{r.consistent ? <StateChip state="ACCEPTED" /> : <StateChip state="REJECTED" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Outbound queue" subtitle="Delivery intents recorded with the business event. With no transport configured they are stored as SKIPPED, never silently queued.">
            <ul className="space-y-1.5 text-xs">
              {Object.keys({ QUEUED: 1, SENT: 1, DELIVERED: 1, FAILED: 1, SKIPPED: 1, CANCELLED: 1 })
                .filter((k) => deliveries[k])
                .map((k) => (
                  <li key={k} className="flex items-center justify-between">
                    <span className="uppercase tracking-wide text-slate-500">{k.toLowerCase()}</span>
                    <span className="tabular-nums font-semibold">{deliveries[k]}</span>
                  </li>
                ))}
              {!Object.keys(deliveries).length ? <li className="text-slate-400">Nothing queued.</li> : null}
            </ul>
            {can(actor.role, "notifications.send") ? (
              <div className="mt-3">
                <Form action={drainOutboxAction} submitLabel="Drain queue now" back="/admin/wallet" />
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}
