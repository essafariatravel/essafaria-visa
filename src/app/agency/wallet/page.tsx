import { EmptyState, PageHeader, Badge } from "@/components/admin/ui";
import { Money, Notice, Panel, StateChip } from "@/components/ops/ui";
import { getWallet, listWalletLedger } from "@/lib/billing";
import { resolveAgencyContext } from "@/lib/tenancy";
import { requirePermissionForPage } from "@/lib/authorization";
import { getDb, invoices, invoiceItems } from "@/db";
import { desc, eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

type Q = any;

const KIND_LABEL: Record<string, string> = {
  CREDIT: "Top-up by ESSAFARIA",
  DEBIT: "Application charge",
  REVERSAL: "Reversal",
  ADJUSTMENT: "Adjustment",
  REFUND: "Refund",
};

/**
 * Wallet and invoices. Read-only by design: the balance is funded manually by
 * ESSAFARIA and there is no online payment gateway in this platform — so the
 * portal shows exactly what the ledger says, with the reference for each move.
 */
export default async function AgencyWalletPage() {
  const user = await requirePermissionForPage("wallet.read");
  const agencyId = await resolveAgencyContext(user);
  if (!agencyId) return <EmptyState title="No agency linked to your account" />;
  const wallet = await getWallet(agencyId);
  const { rows } = await listWalletLedger(agencyId, { limit: 40 });
  const t: Q = await getDb();
  const invRows = (await t
    .select()
    .from(invoices)
    .where(eq(invoices.agencyId, agencyId))
    .orderBy(desc(invoices.createdAt))
    .limit(50)) as Array<typeof invoices.$inferSelect>;
  const ids = invRows.map((i) => i.id);
  const items = ids.length
    ? ((await t
        .select()
        .from(invoiceItems)
        .where(sql`${invoiceItems.invoiceId} in (${sql.join(ids.map((i) => sql`${i}`), sql`,`)})`)) as Array<typeof invoiceItems.$inferSelect>)
    : [];

  return (
    <div className="pb-16">
      <PageHeader title="Wallet & invoices" subtitle="Prepaid balance held by ESSAFARIA for your agency. Every charge against a file is listed with its reference." />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className={`text-3xl font-black tabular-nums ${wallet.balanceCents < 0 ? "text-red-600" : ""}`} style={wallet.balanceCents < 0 ? undefined : { color: "var(--color-brand-primary)" }}>
            <Money cents={wallet.balanceCents} code={wallet.currencyCode} />
          </p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Available balance</p>
        </div>
        <div className="card p-5">
          <p className="text-3xl font-black tabular-nums text-slate-800">
            {invRows.filter((i) => Number(i.subtotalCents) - Number(i.paidCents) > 0).length}
          </p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Invoices with a balance</p>
        </div>
        <div className="card p-5">
          <p className="text-3xl font-black tabular-nums text-slate-800">{rows.length ? new Date(rows[0]!.occurredAt).toLocaleDateString() : "—"}</p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Last movement</p>
        </div>
      </div>

      {!wallet.consistent ? (
        <div className="mb-4">
          <Notice kind="error">Ledger mismatch detected — the recorded balance and the sum of transactions differ. ESSAFARIA has been alerted automatically.</Notice>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Invoices">
          {!invRows.length ? (
            <EmptyState title="No invoices yet" hint="An invoice is raised when a file is submitted for processing." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {invRows.map((inv) => {
                const lines = items.filter((i) => i.invoiceId === inv.id);
                const due = Number(inv.subtotalCents) - Number(inv.paidCents);
                return (
                  <li key={inv.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-mono text-xs font-bold text-slate-700">{inv.number}</p>
                        <p className="text-[11px] text-slate-500">{inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : "draft"}</p>
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
                          <span className="flex items-center gap-2 tabular-nums">
                            <StateChip state={l.chargeStatus === "CHARGED" ? "ACCEPTED" : l.chargeStatus === "PENDING" ? "PENDING_REVIEW" : l.chargeStatus === "WAIVED" ? "NOT_APPLICABLE" : "REJECTED"} />
                            <Money cents={Number(l.amountCents)} code={inv.currencyCode} />
                          </span>
                        </li>
                      ))}
                    </ul>
                    {due > 0 ? <p className="mt-1 text-[11px] font-semibold text-red-700">Outstanding: <Money cents={due} code={inv.currencyCode} /></p> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Transactions" subtitle="Every movement of your balance, with what it was for.">
          {!rows.length ? (
            <EmptyState title="No transactions yet" hint="ESSAFARIA funds this wallet manually when a bank transfer arrives." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="th">When</th>
                  <th className="th">What</th>
                  <th className="th text-right">Amount</th>
                  <th className="th text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 align-top">
                    <td className="td text-[11px] text-slate-500">{new Date(r.occurredAt).toLocaleDateString()}</td>
                    <td className="td">
                      <p className="text-xs font-semibold text-slate-700">{KIND_LABEL[r.kind] ?? r.kind}</p>
                      <p className="text-[11px] text-slate-500">{r.reason}</p>
                      {r.referenceLabel ? (
                        <p className="text-[11px]">
                          <span className="font-mono text-slate-400">{r.referenceLabel}</span>
                        </p>
                      ) : null}
                      {r.reference ? <p className="text-[10px] text-slate-400">ref {r.reference}</p> : null}
                    </td>
                    <td className={`td text-right font-semibold tabular-nums ${r.amountCents < 0 ? "text-red-700" : "text-emerald-700"}`}>
                      {r.amountCents < 0 ? "−" : "+"}
                      <Money cents={Math.abs(r.amountCents)} code={r.currencyCode} />
                    </td>
                    <td className="td text-right tabular-nums text-slate-500">
                      <Money cents={r.balanceAfterCents} code={r.currencyCode} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
