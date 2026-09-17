import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  agencyWalletTransactions,
  agencies,
  applicationEvents,
  invoiceItems,
  invoices,
  currencies,
  visaApplications,
  applicationSnapshots,
  type Database,
} from "@/db";
import {
  DomainError,
  affectedRows,
  assertActorPermission,
  assertCents,
  auditIn,
  formatInvoiceReference,
  loadStatusById,
  nextSequence,
} from "@/lib/ops";
import { labelForFeeType, loadSnapshot, type PricedFeeLine } from "@/lib/snapshot";
import { withTx } from "@/lib/with-tx";
import { notify } from "@/lib/notifications";
import { getSettingIn } from "@/lib/config-service";

type Q = any;

/* ============================================================
 * Billing (Phase 3 foundation) + agency wallet (Phase 7).
 *
 * Money rules, enforced here and nowhere else:
 *   • amounts are integer cents in an INT8 column; no float arithmetic
 *   • an application's invoice is generated from its SNAPSHOT, so a later
 *     fee change can never reprice an existing file
 *   • every charge is exactly one invoice_items row keyed by `charge_key`
 *     (unique per invoice) → a retried request cannot double-charge
 *   • the wallet header moves only through a CONDITIONAL UPDATE
 *     (`WHERE balance_cents >= amount`) executed inside the same transaction
 *     as the ledger insert → a race either loses cleanly or overdraws never
 *   • the ledger is append-only; corrections are REVERSAL rows pointing at the
 *     transaction they fix, so the audit trail is never rewritten
 * ============================================================ */

/* ---------------- invoices ---------------- */

export interface InvoiceView {
  id: string;
  number: string;
  agencyId: string;
  applicationId: string | null;
  currencyCode: string;
  status: string;
  subtotalCents: number;
  paidCents: number;
  balanceDueCents: number;
  issuedAt: string | null;
  items: Array<{
    id: string;
    description: string;
    feeType: string;
    unitAmountCents: number;
    quantity: number;
    amountCents: number;
    chargeStatus: string;
  }>;
}

async function loadSnapshotLines(t: Q, app: { currentSnapshotId: string | null }) {
  if (!app.currentSnapshotId) return null;
  // explicitly through the caller's handle — never re-resolve a connection
  return await loadSnapshot(app.currentSnapshotId, t as unknown as Database);
}

/**
 * Create (or return the existing) invoice for an application from its priced
 * snapshot. Idempotent: a second call for the same file returns the same
 * invoice rather than creating a second one.
 */
export async function ensureInvoiceForApplication(
  applicationId: string,
  tx?: Database,
  opts: { status?: "DRAFT" | "PENDING"; actor?: { id: string; email: string; role: string } | null } = {},
): Promise<{ invoiceId: string; created: boolean; subtotalCents: number }> {
  const run = async (tx2: Database) => {
    const t: Q = tx2;
    const apps = (await t
      .select()
      .from(visaApplications)
      .where(eq(visaApplications.id, applicationId))
      .limit(1)) as unknown as Array<{
      id: string;
      reference: string;
      agencyId: string;
      currentSnapshotId: string | null;
      requestedCount: number;
      currencyHint?: string | null;
    }>;
    const app = apps[0];
    if (!app) throw new DomainError("NOT_FOUND", "Application not found");

    const existing = (await t
      .select({ id: invoices.id, subtotalCents: invoices.subtotalCents, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.applicationId, app.id), sql`${invoices.status} <> 'VOID'`))
      .limit(1)) as Array<{ id: string; subtotalCents: number; status: string }>;
    if (existing[0]) {
      return { invoiceId: existing[0].id, created: false, subtotalCents: Number(existing[0].subtotalCents) };
    }

    const snap = await loadSnapshotLines(t, app);
    const currencyCode = snap?.currencyCode ?? (await defaultCurrencyCode(t));
    const lines: PricedFeeLine[] = ((snap?.fees ?? []) as unknown) as PricedFeeLine[];
    const total = lines.reduce((s, l) => s + Number(l.amountCents), 0);
    if (total > 9_000_000_000_000) throw new DomainError("VALIDATION", "Invoice total out of range");

    const period = String(new Date().getUTCFullYear());
    const n = await nextSequence(period, tx2);
    const number = formatInvoiceReference(period, n);

    const inserted = (await t
      .insert(invoices)
      .values({
        id: undefined as never,
        number,
        agencyId: app.agencyId,
        applicationId: app.id,
        currencyCode,
        status: opts.status ?? "PENDING",
        subtotalCents: total,
        paidCents: 0,
        issuedAt: new Date(),
      })
      .returning({ id: invoices.id })) as Array<{ id: string }>;
    const invoiceId = inserted[0]!.id;

    for (const line of lines) {
      const chargeKey = chargeKeyFor(app.id, line);
      await t.insert(invoiceItems).values({
        invoiceId,
        applicationId: app.id,
        description: line.description || labelForFeeType(line.feeType),
        feeType: (line.feeType as never) ?? "SERVICE_FEE",
        unitAmountCents: Number(line.unitAmountCents ?? line.amountCents),
        quantity: Number(line.quantity ?? 1),
        amountCents: Number(line.amountCents),
        visaFeeId: line.visaFeeId ?? null,
        snapshotId: snap?.id ?? null,
        chargeStatus: "PENDING",
        chargeKey,
      });
    }

    await auditIn(tx2, {
      actor: opts.actor ?? null,
      action: "CREATE",
      entityType: "invoice",
      entityId: invoiceId,
      agencyId: app.agencyId,
      changes: { after: { number, totalCents: total, currencyCode, lines: lines.length, fromSnapshot: snap?.id ?? null } },
    });
    await t.insert(applicationEvents).values({
      applicationId: app.id,
      agencyId: app.agencyId,
      type: "INVOICE_ISSUED",
      actorId: opts.actor?.id ?? null,
      actorEmail: opts.actor?.email ?? null,
      actorKind: opts.actor ? "USER" : "SYSTEM",
      message: `Invoice ${number} issued for ${(total / 100).toFixed(2)} ${currencyCode}`,
      customerVisible: true,
    });
    return { invoiceId, created: true, subtotalCents: total };
  };
  if (tx) return run(tx);
  return withTx((t) => run(t as Database));
}

/** Stable, deterministic charge identity: one line per (application, fee type,
 *  currency) — a re-run never duplicates it. */
export function chargeKeyFor(applicationId: string, line: { feeType: string; currencyCode?: string }): string {
  return `${applicationId}|${line.feeType}|${line.currencyCode ?? ""}`;
}

export async function defaultCurrencyCode(t: Q): Promise<string> {
  const rows = (await t
    .select({ code: currencies.code })
    .from(currencies)
    .where(and(eq(currencies.isBase, true), eq(currencies.isActive, true)))
    .limit(1)) as Array<{ code: string }>;
  if (rows[0]) return rows[0].code;
  const any = (await t
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.isActive, true))
    .orderBy(asc(currencies.code))
    .limit(1)) as Array<{ code: string }>;
  if (!any[0]) throw new DomainError("CONFIG", "No active currency is configured");
  return any[0].code;
}

/** Recompute an invoice from its file's snapshot after a pricing-relevant
 *  change (applicant count / priority), but ONLY while nothing has been
 *  collected — once money moved, the invoice is history. */
export async function recomputeInvoiceTotals(applicationId: string, tx?: Database): Promise<void> {
  const run = async (tx2: Database) => {
    const t: Q = tx2;
    const inv = (await t
      .select()
      .from(invoices)
      .where(and(eq(invoices.applicationId, applicationId), sql`${invoices.status} <> 'VOID'`))
      .limit(1)) as Array<typeof invoices.$inferSelect>;
    const invoice = inv[0];
    if (!invoice) return;
    if (Number(invoice.paidCents) !== 0) return; // charged: never rewrite
    const items = (await t
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoice.id))) as Array<typeof invoiceItems.$inferSelect>;
    const charged = items.some((i) => i.chargeStatus !== "PENDING");
    if (charged) return;

    const apps = (await t
      .select({ currentSnapshotId: visaApplications.currentSnapshotId, agencyId: visaApplications.agencyId })
      .from(visaApplications)
      .where(eq(visaApplications.id, applicationId))
      .limit(1)) as Array<{ currentSnapshotId: string | null; agencyId: string }>;
    const snap = apps[0]?.currentSnapshotId ? await loadSnapshot(apps[0].currentSnapshotId, tx2) : null;
    if (!snap) return;
    const lines = (snap.fees as unknown) as PricedFeeLine[];
    const total = lines.reduce((s, l) => s + Number(l.amountCents), 0);

    await t.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoice.id));
    for (const line of lines) {
      await t.insert(invoiceItems).values({
        invoiceId: invoice.id,
        applicationId,
        description: line.description || labelForFeeType(line.feeType),
        feeType: (line.feeType as never) ?? "SERVICE_FEE",
        unitAmountCents: Number(line.unitAmountCents),
        quantity: Number(line.quantity),
        amountCents: Number(line.amountCents),
        visaFeeId: line.visaFeeId ?? null,
        snapshotId: snap.id,
        chargeStatus: "PENDING",
        chargeKey: chargeKeyFor(applicationId, line),
      });
    }
    await t.update(invoices).set({ subtotalCents: total, updatedAt: new Date() }).where(eq(invoices.id, invoice.id));
    await auditIn(tx2, {
      actor: null,
      action: "UPDATE",
      entityType: "invoice",
      entityId: invoice.id,
      agencyId: apps[0]!.agencyId,
      changes: { before: { subtotalCents: Number(invoice.subtotalCents) }, after: { subtotalCents: total } },
    });
  };
  if (tx) return run(tx);
  return withTx((t) => run(t as Database));
}

export async function getInvoiceForApplication(
  applicationId: string,
  tx?: Database,
  opts: { includeVoid?: boolean } = {},
): Promise<InvoiceView | null> {
  const t: Q = tx ?? (await getDb());
  const rows = (await t
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.applicationId, applicationId),
        // a void invoice is invisible by default (it is not a live bill) but
        // must stay readable for audit screens
        opts.includeVoid ? undefined : sql`${invoices.status} <> 'VOID'`,
      ),
    )
    .limit(1)) as Array<typeof invoices.$inferSelect>;
  const invoice = rows[0];
  if (!invoice) return null;
  const items = (await t
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoice.id))
    .orderBy(asc(invoiceItems.createdAt))) as Array<typeof invoiceItems.$inferSelect>;
  return toInvoiceView(invoice, items);
}

function toInvoiceView(
  invoice: typeof invoices.$inferSelect,
  items: Array<typeof invoiceItems.$inferSelect>,
): InvoiceView {
  const subtotal = Number(invoice.subtotalCents);
  const paid = Number(invoice.paidCents);
  return {
    id: invoice.id,
    number: invoice.number,
    agencyId: invoice.agencyId,
    applicationId: invoice.applicationId,
    currencyCode: invoice.currencyCode,
    status: invoice.status,
    subtotalCents: subtotal,
    paidCents: paid,
    balanceDueCents: subtotal - paid,
    issuedAt: invoice.issuedAt ? String(invoice.issuedAt) : null,
    items: items.map((i) => ({
      id: i.id,
      description: i.description,
      feeType: i.feeType,
      unitAmountCents: Number(i.unitAmountCents),
      quantity: i.quantity,
      amountCents: Number(i.amountCents),
      chargeStatus: i.chargeStatus,
    })),
  };
}

/* ---------------- wallet ---------------- */

export interface WalletView {
  agencyId: string;
  currencyCode: string;
  balanceCents: number;
  ledgerSumCents: number;
  consistent: boolean;
  lastTransactionAt: string | null;
}

export async function getWallet(agencyId: string, tx?: Database): Promise<WalletView> {
  const t: Q = tx ?? (await getDb());
  const ag = (await t
    .select({ id: agencies.id, balance: agencies.walletBalanceCents })
    .from(agencies)
    .where(eq(agencies.id, agencyId))
    .limit(1)) as Array<{ id: string; balance: number }>;
  const agency = ag[0];
  if (!agency) throw new DomainError("NOT_FOUND", "Agency not found");
  const sum = (await t
    .select({
      total: sql<number>`coalesce(sum(${agencyWalletTransactions.amountCents}), 0)::bigint`,
      last: sql<string>`max(${agencyWalletTransactions.occurredAt})`,
    })
    .from(agencyWalletTransactions)
    .where(eq(agencyWalletTransactions.agencyId, agencyId))) as Array<{ total: string | number; last: string | null }>;
  const ledgerSum = Number(sum[0]?.total ?? 0);
  const balance = Number(agency.balance);
  return {
    agencyId,
    currencyCode: await defaultCurrencyCode(t),
    balanceCents: balance,
    ledgerSumCents: ledgerSum,
    consistent: balance === ledgerSum,
    lastTransactionAt: sum[0]?.last ? String(sum[0].last) : null,
  };
}

/**
 * Manual credit by an authorized ESSAFARIA admin (the only funding path —
 * there is no online payment gateway by design).
 *
 * Idempotency: if `idempotencyKey` is supplied and already used by this agency,
 * the existing transaction is returned unchanged (deduped: true).
 */
export async function creditWallet(
  actor: { id: string; email: string; role: string },
  input: {
    agencyId: string;
    amountCents: number;
    currencyCode: string;
    reason: string;
    reference?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<{ txId: string; balanceAfterCents: number; deduped: boolean }> {
  // Money only moves for actors whose ROLE may move it — checked here, not
  // only at the route, because funding a wallet is a consequential act.
  assertActorPermission(actor, "wallet.write");
  const amount = assertCents(input.amountCents, "amount");
  if (amount <= 0) throw new DomainError("VALIDATION", "Credit amount must be positive");
  const reason = (input.reason ?? "").trim();
  if (reason.length < 5) throw new DomainError("VALIDATION", "A reason is required for every money movement");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    // dedupe first, inside the transaction, so a replay cannot double-credit
    if (input.idempotencyKey) {
      const prior = (await t
        .select({ id: agencyWalletTransactions.id, after: agencyWalletTransactions.balanceAfterCents })
        .from(agencyWalletTransactions)
        .where(
          and(
            eq(agencyWalletTransactions.agencyId, input.agencyId),
            eq(agencyWalletTransactions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)) as Array<{ id: string; after: number }>;
      if (prior[0]) return { txId: prior[0].id, balanceAfterCents: Number(prior[0].after), deduped: true };
    }
    await ensureCurrency(t, input.currencyCode);
    const ag = (await t
      .select({ id: agencies.id, balance: agencies.walletBalanceCents })
      .from(agencies)
      .where(eq(agencies.id, input.agencyId))
      .limit(1)
      .for("update")) as unknown as Array<{ id: string; balance: number }>;
    const agency = ag[0];
    if (!agency) throw new DomainError("NOT_FOUND", "Agency not found");
    const before = Number(agency.balance);
    const after = before + amount;
    if (after > 9_000_000_000_000) throw new DomainError("VALIDATION", "Resulting balance out of range");

    // conditional move: the header only advances from the value we read
    const moved = await t
      .update(agencies)
      .set({ walletBalanceCents: after, updatedAt: new Date() })
      .where(and(eq(agencies.id, agency.id), eq(agencies.walletBalanceCents, before)));
    if (affectedRows(moved) !== 1) {
      throw new DomainError("RACE", "Wallet changed while this was being applied — retry");
    }
    const inserted = (await t
      .insert(agencyWalletTransactions)
      .values({
        agencyId: agency.id,
        currencyCode: input.currencyCode,
        kind: "CREDIT",
        amountCents: amount,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        actorId: actor.id,
        actorEmail: actor.email,
        reason: reason.slice(0, 500),
        reference: input.reference?.slice(0, 120) ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: agencyWalletTransactions.id })) as Array<{ id: string }>;
    const txId = inserted[0]!.id;

    await auditIn(tx, {
      actor,
      action: "CREDIT",
      entityType: "agency_wallet",
      entityId: agency.id,
      agencyId: agency.id,
      changes: { before: { balanceCents: before }, after: { balanceCents: after, amountCents: amount } },
      metadata: { txId, reference: input.reference ?? null, reason },
    });
    await notify(
      {
        agencyId: agency.id,
        kind: "WALLET_CREDIT",
        title: `Wallet credited ${formatAmount(amount, input.currencyCode)}`,
        body: `Your ESSAFARIA wallet balance is now ${formatAmount(after, input.currencyCode)}. (${reason})`,
        link: "/agency/wallet",
        severity: "SUCCESS",
        dedupeKey: `WALLET_CREDIT:${txId}`,
        email: {},
      },
      tx,
    );
    return { txId, balanceAfterCents: after, deduped: false };
  });
}

async function ensureCurrency(t: Q, code: string): Promise<void> {
  const rows = (await t
    .select({ code: currencies.code })
    .from(currencies)
    .where(and(eq(currencies.code, code), eq(currencies.isActive, true)))
    .limit(1)) as Array<{ code: string }>;
  if (!rows[0]) throw new DomainError("CONFIG", `Currency ${code} is not configured`);
}

export function formatAmount(cents: number, code: string): string {
  const value = (cents / 100).toFixed(2);
  return `${value} ${code}`;
}

/**
 * Charge the pending items of an application's invoice against the wallet.
 *
 * Concurrency/idempotency design:
 *   1. invoice + items are locked and re-read inside the transaction
 *   2. each item moves PENDING → CHARGED with a conditional UPDATE; a row that
 *      is already CHARGED returns rowCount 0 and is skipped (no double charge)
 *   3. the wallet header moves with `WHERE balance_cents >= total`; if another
 *      request took the money first, 0 rows update → INSUFFICIENT_FUNDS and the
 *      whole transaction (including the item flags) rolls back
 *   4. one ledger row per charge, with before/after, so sum(ledger) = balance
 */
export async function chargeApplication(
  actor: { id: string; email: string; role: string },
  applicationId: string,
  opts: { idempotencyKey?: string | null; allowNegative?: boolean } = {},
): Promise<{ chargedCents: number; balanceAfterCents: number; invoiceId: string; alreadyCharged: boolean }> {
  assertActorPermission(actor, "wallet.charge");
  return withTx((tx) => chargeInsideTx(actor, applicationId, opts, tx));
}

/**
 * The charge itself, usable inside a caller's transaction.
 *
 * Kept separate so submission billing can charge without opening a second
 * transaction (which would escape the atomic unit on PostgreSQL and deadlock on
 * the embedded driver).
 */
async function chargeInsideTx(
  actor: { id: string; email: string; role: string },
  applicationId: string,
  opts: { idempotencyKey?: string | null; allowNegative?: boolean },
  tx: Database,
): Promise<{ chargedCents: number; balanceAfterCents: number; invoiceId: string; alreadyCharged: boolean }> {
  {
    const t: Q = tx;
    const apps = (await t
      .select({ id: visaApplications.id, reference: visaApplications.reference, agencyId: visaApplications.agencyId })
      .from(visaApplications)
      .where(eq(visaApplications.id, applicationId))
      .limit(1)) as Array<{ id: string; reference: string; agencyId: string }>;
    const app = apps[0];
    if (!app) throw new DomainError("NOT_FOUND", "Application not found");

    const invRows = (await t
      .select()
      .from(invoices)
      .where(and(eq(invoices.applicationId, app.id), sql`${invoices.status} <> 'VOID'`))
      .limit(1)
      .for("update")) as unknown as Array<typeof invoices.$inferSelect>;
    let invoice = invRows[0];
    if (!invoice) {
      await ensureInvoiceForApplication(app.id, tx, { status: "PENDING", actor });
      const again = (await t
        .select()
        .from(invoices)
        .where(and(eq(invoices.applicationId, app.id), sql`${invoices.status} <> 'VOID'`))
        .limit(1)) as Array<typeof invoices.$inferSelect>;
      invoice = again[0];
      if (!invoice) throw new DomainError("CONFIG", "Invoice could not be created");
    }
    if (invoice.status === "PAID") {
      return { chargedCents: 0, balanceAfterCents: 0, invoiceId: invoice.id, alreadyCharged: true };
    }

    const pending = (await t
      .select()
      .from(invoiceItems)
      .where(and(eq(invoiceItems.invoiceId, invoice.id), eq(invoiceItems.chargeStatus, "PENDING")))
      .orderBy(asc(invoiceItems.createdAt))) as Array<typeof invoiceItems.$inferSelect>;
    if (!pending.length) {
      return {
        chargedCents: 0,
        balanceAfterCents: Number((await getWallet(app.agencyId, tx)).balanceCents),
        invoiceId: invoice.id,
        alreadyCharged: true,
      };
    }
    const total = pending.reduce((s, i) => s + Number(i.amountCents), 0);
    if (total <= 0) {
      for (const item of pending) {
        await t
          .update(invoiceItems)
          .set({ chargeStatus: "WAIVED", chargedAt: new Date() })
          .where(and(eq(invoiceItems.id, item.id), eq(invoiceItems.chargeStatus, "PENDING")));
      }
      await t.update(invoices).set({ status: "PAID", updatedAt: new Date() }).where(eq(invoices.id, invoice.id));
      return { chargedCents: 0, balanceAfterCents: 0, invoiceId: invoice.id, alreadyCharged: false };
    }

    const ag = (await t
      .select({ id: agencies.id, balance: agencies.walletBalanceCents })
      .from(agencies)
      .where(eq(agencies.id, app.agencyId))
      .limit(1)
      .for("update")) as unknown as Array<{ id: string; balance: number }>;
    const agency = ag[0];
    if (!agency) throw new DomainError("NOT_FOUND", "Agency not found");
    const before = Number(agency.balance);
    const after = before - total;
    const allowNegative =
      opts.allowNegative ?? (await getSettingIn<boolean>(t, "ops.allowNegativeBalance", false)) === true;
    if (after < 0 && !allowNegative) {
      throw new DomainError(
        "INSUFFICIENT_FUNDS",
        `Insufficient wallet balance: ${formatAmount(before, invoice.currencyCode)} available, ${formatAmount(total, invoice.currencyCode)} required`,
      );
    }

    const moved = await t
      .update(agencies)
      .set({ walletBalanceCents: after, updatedAt: new Date() })
      .where(
        allowNegative
          ? and(eq(agencies.id, agency.id), eq(agencies.walletBalanceCents, before))
          : and(eq(agencies.id, agency.id), eq(agencies.walletBalanceCents, before), sql`${agencies.walletBalanceCents} >= ${total}`),
      );
    if (affectedRows(moved) !== 1) {
      throw new DomainError("INSUFFICIENT_FUNDS", "Wallet balance changed — nothing was charged. Reload and retry.");
    }

    const ledgerInsert = (await t
      .insert(agencyWalletTransactions)
      .values({
        agencyId: agency.id,
        currencyCode: invoice.currencyCode,
        kind: "DEBIT",
        amountCents: -total,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        applicationId: app.id,
        invoiceId: invoice.id,
        actorId: actor.id,
        actorEmail: actor.email,
        reason: `Charge for application ${app.reference}`,
        // Exactly-once is guaranteed by the line state machine (PENDING →
        // CHARGED is a conditional claim), so no synthetic key is invented here:
        // a fixed per-file key would wrongly block a legitimate re-charge after
        // a reversal. Callers that DO have a request identity (an
        // Idempotency-Key header from an integration) pass it explicitly and get
        // absorption on replay.
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning({ id: agencyWalletTransactions.id })) as Array<{ id: string }>;
    const walletTxId = ledgerInsert[0]!.id;

    let marked = 0;
    for (const item of pending) {
      const res = await t
        .update(invoiceItems)
        .set({ chargeStatus: "CHARGED", chargedAt: new Date(), walletTxId, updatedAt: new Date() })
        .where(and(eq(invoiceItems.id, item.id), eq(invoiceItems.chargeStatus, "PENDING")));
      marked += affectedRows(res);
    }
    if (pending.length === 1) {
      // single-line invoices carry a direct item link; multi-line charges are
      // traced through wallet_tx_id on each item instead
      await t
        .update(agencyWalletTransactions)
        .set({ invoiceItemId: pending[0]!.id })
        .where(eq(agencyWalletTransactions.id, walletTxId));
    }
    if (marked !== pending.length) {
      // Another charge claimed some items while we worked. The conditional
      // wallet update already protected the money; abort for a clean retry.
      throw new DomainError("RACE", "Charge raced with another operation — nothing was double-charged. Retry.");
    }

    const paidTotal = Number(invoice.paidCents) + total;
    await t
      .update(invoices)
      .set({
        paidCents: paidTotal,
        status: paidTotal >= Number(invoice.subtotalCents) ? "PAID" : "PARTIALLY_PAID",
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoice.id));

    await t.insert(applicationEvents).values({
      applicationId: app.id,
      agencyId: app.agencyId,
      type: "PAYMENT_CHARGED",
      actorId: actor.id,
      actorEmail: actor.email,
      actorKind: "USER",
      message: `Charged ${formatAmount(total, invoice.currencyCode)} to the agency wallet`,
      customerVisible: true,
      payload: { walletTxId, invoiceId: invoice.id, amountCents: total },
    });
    await auditIn(tx, {
      actor,
      action: "CHARGE",
      entityType: "agency_wallet",
      entityId: agency.id,
      agencyId: agency.id,
      changes: { before: { balanceCents: before }, after: { balanceCents: after, chargedCents: total } },
      metadata: { applicationId: app.id, invoiceId: invoice.id, walletTxId },
    });
    await notify(
      {
        agencyId: agency.id,
        applicationId: app.id,
        kind: "WALLET_CHARGED",
        title: `${app.reference}: ${formatAmount(total, invoice.currencyCode)} charged`,
        body: `Wallet balance after this charge: ${formatAmount(after, invoice.currencyCode)}.`,
        link: "/agency/wallet",
        severity: after < 0 ? "WARNING" : "INFO",
        audienceRole: "AGENCY_ADMIN",
        dedupeKey: `WALLET_CHARGED:${walletTxId}`,
        email: {},
      },
      tx,
    );
    if (after < 0) {
      await notify(
        {
          staffOnly: true,
          agencyId: agency.id,
          kind: "WALLET_OVERDRAWN",
          title: `Negative wallet: ${agency.id}`,
          body: `${app.reference} took the balance to ${formatAmount(after, invoice.currencyCode)} under the allow-negative policy.`,
          link: "/admin/wallet",
          severity: "WARNING",
          dedupeKey: `WALLET_OVERDRAWN:${walletTxId}`,
        },
        tx,
      );
    }
    return { chargedCents: total, balanceAfterCents: after, invoiceId: invoice.id, alreadyCharged: false };
  }
}

/** Alias used by applySubmissionBilling — never opens a transaction itself. */
async function chargeApplicationLocked(
  actor: { id: string; email: string; role: string },
  applicationId: string,
  opts: { allowNegative?: boolean },
  tx: Database,
): Promise<{ chargedCents: number; balanceAfterCents: number }> {
  const r = await chargeInsideTx(actor, applicationId, opts, tx);
  return { chargedCents: r.chargedCents, balanceAfterCents: r.balanceAfterCents };
}

/** Reverse a wallet transaction (e.g. cancelled application). Creates a new
 *  ledger row; the original stays as history. Idempotent per (tx, reason). */
export async function reverseWalletTransaction(
  actor: { id: string; email: string; role: string },
  input: { walletTxId: string; reason: string; kind?: "REVERSAL" | "ADJUSTMENT" | "REFUND" },
): Promise<{ txId: string; balanceAfterCents: number }> {
  assertActorPermission(actor, "wallet.write");
  const reason = (input.reason ?? "").trim();
  if (reason.length < 5) throw new DomainError("VALIDATION", "A reason is required for every money movement");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const orig = (await t
      .select()
      .from(agencyWalletTransactions)
      .where(eq(agencyWalletTransactions.id, input.walletTxId))
      .limit(1)
      .for("update")) as unknown as Array<typeof agencyWalletTransactions.$inferSelect>;
    const o = orig[0];
    if (!o) throw new DomainError("NOT_FOUND", "Wallet transaction not found");
    // Has this transaction already been reversed? A reversal is a NEW row that
    // points back at what it fixes, so the lookup is on reverses_tx_id alone —
    // and the predicate must stay parenthesised, because `A AND B OR true`
    // matches every row and would silently disable the guard.
    const already = (await t
      .select({ id: agencyWalletTransactions.id, after: agencyWalletTransactions.balanceAfterCents })
      .from(agencyWalletTransactions)
      .where(and(eq(agencyWalletTransactions.reversesTxId, o.id), sql`${agencyWalletTransactions.kind} = 'REVERSAL'`))
      .limit(1)) as Array<{ id: string; after: number }>;
    if (o.kind === "REVERSAL") throw new DomainError("STATE_CONFLICT", "A reversal row cannot itself be reversed");
    if (already[0]) {
      return { txId: already[0].id, balanceAfterCents: Number(already[0].after) };
    }
    const kind = input.kind ?? "REVERSAL";
    const amount = -Number(o.amountCents);
    const ag = (await t
      .select({ balance: agencies.walletBalanceCents })
      .from(agencies)
      .where(eq(agencies.id, o.agencyId))
      .limit(1)
      .for("update")) as unknown as Array<{ balance: number }>;
    const before = Number(ag[0]!.balance);
    const after = before + amount;
    const moved = await t
      .update(agencies)
      .set({ walletBalanceCents: after, updatedAt: new Date() })
      .where(and(eq(agencies.id, o.agencyId), eq(agencies.walletBalanceCents, before)));
    if (affectedRows(moved) !== 1) throw new DomainError("RACE", "Wallet changed — retry");
    const inserted = (await t
      .insert(agencyWalletTransactions)
      .values({
        agencyId: o.agencyId,
        currencyCode: o.currencyCode,
        kind,
        amountCents: amount,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        applicationId: o.applicationId,
        invoiceId: o.invoiceId,
        reversesTxId: o.id,
        actorId: actor.id,
        actorEmail: actor.email,
        reason: reason.slice(0, 500),
        idempotencyKey: `REVERSE:${o.id}`,
      })
      .returning({ id: agencyWalletTransactions.id })) as Array<{ id: string }>;
    const txId = inserted[0]!.id;

    // Return every line this transaction settled to PENDING, so a reopened file
    // can be charged again. The REVERSAL ledger row is the permanent record that
    // the original charge was undone — items are never left in a state that
    // pretends they were paid.
    await t
      .update(invoiceItems)
      .set({ chargeStatus: "PENDING", walletTxId: null, chargedAt: null, updatedAt: new Date() })
      .where(and(eq(invoiceItems.walletTxId, o.id), eq(invoiceItems.chargeStatus, "CHARGED")));
    if (o.invoiceItemId) {
      await t
        .update(invoiceItems)
        .set({ chargeStatus: "PENDING", walletTxId: null, chargedAt: null, updatedAt: new Date() })
        .where(and(eq(invoiceItems.id, o.invoiceItemId), eq(invoiceItems.chargeStatus, "CHARGED")));
    }
    if (o.invoiceId) {
      const items = (await t
        .select({ paid: sql<number>`coalesce(sum(case when ${invoiceItems.chargeStatus} = 'CHARGED' then ${invoiceItems.amountCents} else 0 end), 0)::bigint` })
        .from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, o.invoiceId))) as Array<{ paid: string | number }>;
      const inv = (await t
        .select({ subtotal: invoices.subtotalCents, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, o.invoiceId))
        .limit(1)) as Array<{ subtotal: number; status: string }>;
      if (inv[0]) {
        const paid = Number(items[0]?.paid ?? 0);
        const nextStatus = paid <= 0 ? "PENDING" : paid >= Number(inv[0].subtotal) ? "PAID" : "PARTIALLY_PAID";
        await t.update(invoices).set({ paidCents: paid, status: nextStatus, updatedAt: new Date() }).where(eq(invoices.id, o.invoiceId));
      }
    }
    if (o.applicationId) {
      await t.insert(applicationEvents).values({
        applicationId: o.applicationId,
        agencyId: o.agencyId,
        type: "PAYMENT_REVERSED",
        actorId: actor.id,
        actorEmail: actor.email,
        actorKind: "USER",
        message: `${formatAmount(Math.abs(amount), o.currencyCode)} returned to the wallet — ${reason}`,
        customerVisible: true,
        payload: { walletTxId: txId, reverses: o.id },
      });
    }
    await auditIn(tx, {
      actor,
      action: "REVERSAL",
      entityType: "agency_wallet",
      entityId: o.agencyId,
      agencyId: o.agencyId,
      changes: { before: { balanceCents: before }, after: { balanceCents: after, amountCents: amount } },
      metadata: { reversesTxId: o.id, kind, reason },
    });
    return { txId, balanceAfterCents: after };
  });
}

/* ---------------- administrative adjustments ---------------- */

/**
 * A signed correction (refund, waiver, manual adjustment) that may NOT take the
 * balance below zero unless the platform is explicitly configured to allow it.
 * Same atomic pattern as a credit: conditional header move + append-only ledger.
 */
export async function adjustWallet(
  actor: { id: string; email: string; role: string },
  input: {
    agencyId: string;
    amountCents: number;
    kind: "ADJUSTMENT" | "REFUND";
    currencyCode: string;
    reason: string;
    reference?: string | null;
    idempotencyKey?: string | null;
    applicationId?: string | null;
  },
): Promise<{ txId: string; balanceAfterCents: number; deduped: boolean }> {
  assertActorPermission(actor, "wallet.write");
  const amount = assertCents(input.amountCents, "amount");
  if (amount === 0) throw new DomainError("VALIDATION", "An adjustment of zero changes nothing");
  const reason = (input.reason ?? "").trim();
  if (reason.length < 5) throw new DomainError("VALIDATION", "A reason is required for every money movement");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    if (input.idempotencyKey) {
      const prior = (await t
        .select({ id: agencyWalletTransactions.id, after: agencyWalletTransactions.balanceAfterCents })
        .from(agencyWalletTransactions)
        .where(
          and(
            eq(agencyWalletTransactions.agencyId, input.agencyId),
            eq(agencyWalletTransactions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)) as Array<{ id: string; after: number }>;
      if (prior[0]) return { txId: prior[0].id, balanceAfterCents: Number(prior[0].after), deduped: true };
    }
    await ensureCurrency(t, input.currencyCode);
    const ag = (await t
      .select({ id: agencies.id, balance: agencies.walletBalanceCents })
      .from(agencies)
      .where(eq(agencies.id, input.agencyId))
      .limit(1)
      .for("update")) as unknown as Array<{ id: string; balance: number }>;
    const agency = ag[0];
    if (!agency) throw new DomainError("NOT_FOUND", "Agency not found");
    const before = Number(agency.balance);
    const signed = input.kind === "REFUND" ? Math.abs(amount) : amount;
    const after = before + signed;
    const allowNegative = await getSettingIn<boolean>(t, "ops.allowNegativeBalance", false);
    if (after < 0 && !allowNegative) {
      throw new DomainError(
        "INSUFFICIENT_FUNDS",
        `This adjustment would take the balance to ${formatAmount(after, input.currencyCode)}, below zero. Allow negative balances in Settings → Operations only if that is a real business decision.`,
      );
    }
    const moved = await t
      .update(agencies)
      .set({ walletBalanceCents: after, updatedAt: new Date() })
      .where(and(eq(agencies.id, agency.id), eq(agencies.walletBalanceCents, before)));
    if (affectedRows(moved) !== 1) throw new DomainError("RACE", "Wallet changed while this was being applied — retry");
    const inserted = (await t
      .insert(agencyWalletTransactions)
      .values({
        agencyId: agency.id,
        currencyCode: input.currencyCode,
        kind: input.kind,
        amountCents: signed,
        balanceBeforeCents: before,
        balanceAfterCents: after,
        applicationId: input.applicationId ?? null,
        actorId: actor.id,
        actorEmail: actor.email,
        reason: reason.slice(0, 500),
        reference: input.reference?.slice(0, 120) ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: agencyWalletTransactions.id })) as Array<{ id: string }>;
    const txId = inserted[0]!.id;
    await auditIn(tx, {
      actor,
      // audit_action is a closed enum in the schema; "adjustment" is carried in
      // metadata rather than invented as an action value.
      action: input.kind === "REFUND" ? "REVERSAL" : "UPDATE",
      entityType: "agency_wallet",
      entityId: agency.id,
      agencyId: agency.id,
      changes: { before: { balanceCents: before }, after: { balanceCents: after, amountCents: signed } },
      metadata: { txId, kind: input.kind, reason },
    });
    await notify(
      {
        agencyId: agency.id,
        kind: input.kind === "REFUND" ? "WALLET_REFUND" : "WALLET_ADJUSTMENT",
        title: `${input.kind === "REFUND" ? "Refund" : "Adjustment"} of ${formatAmount(Math.abs(signed), input.currencyCode)}`,
        body: `${reason} New balance: ${formatAmount(after, input.currencyCode)}.`,
        link: "/agency/wallet",
        severity: "INFO",
        dedupeKey: `WALLET_ADJ:${txId}`,
        email: {},
      },
      tx,
    );
    return { txId, balanceAfterCents: after, deduped: false };
  });
}

/** Void an invoice that has not been charged (a cancelled file, a misissue). */
export async function voidInvoice(
  actor: { id: string; email: string; role: string },
  invoiceId: string,
  reason: string,
): Promise<void> {
  assertActorPermission(actor, "invoices.write");
  const why = (reason ?? "").trim();
  if (why.length < 5) throw new DomainError("VALIDATION", "A reason is required to void an invoice");
  return withTx(async (tx: Database) => {
    const t: Q = tx;
    const rows = (await t
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1)
      .for("update")) as unknown as Array<typeof invoices.$inferSelect>;
    const invoice = rows[0];
    if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found");
    if (Number(invoice.paidCents) !== 0) {
      throw new DomainError("STATE_CONFLICT", "Money has already moved against this invoice — reverse the wallet transaction instead");
    }
    if (invoice.status === "VOID") return;
    await t
      .update(invoices)
      .set({ status: "VOID", voidReason: why.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(invoices.id, invoice.id), sql`${invoices.paidCents} = 0`));
    await t
      .update(invoiceItems)
      .set({ chargeStatus: "WAIVED", updatedAt: new Date() })
      .where(and(eq(invoiceItems.invoiceId, invoice.id), eq(invoiceItems.chargeStatus, "PENDING")));
    if (invoice.applicationId) {
      await t.insert(applicationEvents).values({
        applicationId: invoice.applicationId,
        agencyId: invoice.agencyId,
        type: "INVOICE_VOIDED",
        actorId: actor.id,
        actorEmail: actor.email,
        message: `Invoice ${invoice.number} voided — ${why}`.slice(0, 2000),
        customerVisible: true,
      });
    }
    await auditIn(tx, {
      actor,
      action: "UPDATE",
      entityType: "invoice",
      entityId: invoice.id,
      agencyId: invoice.agencyId,
      changes: { before: { status: invoice.status }, after: { status: "VOID", reason: why } },
    });
  });
}

/**
 * Submission billing: raise the invoice, and charge it only when the platform
 * is configured to do so. Money never moves as a side effect of a status change
 * unless an administrator opted in.
 */
export async function applySubmissionBilling(
  actor: { id: string; email: string; role: string } | null,
  applicationId: string,
  tx?: Database,
): Promise<{ invoiceId: string; chargedCents: number; balanceAfterCents: number | null }> {
  const run = async (tx2: Database) => {
    const t: Q = tx2;
    const inv = await ensureInvoiceForApplication(applicationId, tx2, { status: "PENDING", actor });
    const apps = (await t
      .select({ agencyId: visaApplications.agencyId, reference: visaApplications.reference })
      .from(visaApplications)
      .where(eq(visaApplications.id, applicationId))
      .limit(1)) as Array<{ agencyId: string; reference: string }>;
    const app = apps[0]!;
    await raiseLowBalanceAlert(t, app.agencyId, tx2);
    const auto = await getSettingIn<boolean>(t, "ops.autoChargeOnSubmit", false);
    if (!auto) return { invoiceId: inv.invoiceId, chargedCents: 0, balanceAfterCents: null };
    if (!actor) return { invoiceId: inv.invoiceId, chargedCents: 0, balanceAfterCents: null };
    const allowNegative = await getSettingIn<boolean>(t, "ops.allowNegativeBalance", false);
    try {
      const charged = await chargeApplicationLocked(actor, applicationId, { allowNegative }, tx2);
      await raiseLowBalanceAlert(t, app.agencyId, tx2);
      return { invoiceId: inv.invoiceId, chargedCents: charged.chargedCents, balanceAfterCents: charged.balanceAfterCents };
    } catch (err) {
      // Insufficient funds must not undo the status change; the desk sees the
      // outstanding invoice and the alert instead.
      const code = (err as DomainError).code;
      if (code === "INSUFFICIENT_FUNDS") {
        await notify(
          {
            staffOnly: true,
            audienceRole: "ACCOUNTING",
            applicationId,
            agencyId: app.agencyId,
            kind: "CHARGE_DEFERRED",
            title: `${app.reference}: charge deferred — insufficient wallet balance`,
            body: (err as Error).message,
            link: "/admin/wallet",
            severity: "ACTION_REQUIRED",
            dedupeKey: `CHARGE_DEFERRED:${applicationId}:${new Date().toISOString().slice(0, 10)}`,
          },
          tx2,
        );
        return { invoiceId: inv.invoiceId, chargedCents: 0, balanceAfterCents: null };
      }
      throw err;
    }
  };
  if (tx) return run(tx);
  return withTx((t) => run(t));
}

/** Alert accounting once per day per agency when the balance drops under the
 *  configured floor. Idempotent by dedupe key, so retries do not spam. */
export async function raiseLowBalanceAlert(t: Q, agencyId: string, tx?: Database): Promise<boolean> {
  const threshold = Number(await getSettingIn<number>(t, "ops.walletLowBalanceThresholdCents", 0) ?? 0);
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  const ag = (await t.select({ balance: agencies.walletBalanceCents, name: agencies.name }).from(agencies).where(eq(agencies.id, agencyId)).limit(1)) as Array<{ balance: number; name: string }>;
  const agency = ag[0];
  if (!agency) return false;
  if (Number(agency.balance) >= threshold) return false;
  const code = await import("@/lib/notifications");
  await code.notify(
    {
      staffOnly: true,
      audienceRole: "ACCOUNTING",
      agencyId,
      kind: "WALLET_LOW",
      title: `Low wallet balance: ${agency.name}`,
      body: `Balance ${formatAmount(Number(agency.balance), "EUR")} is below the ${formatAmount(threshold, "EUR")} floor. Fund it so applications can keep moving.`,
      link: "/admin/wallet",
      severity: "WARNING",
      dedupeKey: `WALLET_LOW:${agencyId}:${new Date().toISOString().slice(0, 10)}`,
    },
    (tx ?? t) as unknown as Database,
  );
  return true;
}

/* ---------------- reporting helpers ---------------- */

export interface WalletLedgerRow {
  id: string;
  kind: string;
  amountCents: number;
  balanceBeforeCents: number;
  balanceAfterCents: number;
  currencyCode: string;
  reason: string;
  reference: string | null;
  actorEmail: string | null;
  applicationId: string | null;
  referenceLabel: string | null;
  occurredAt: string;
}

export async function listWalletLedger(
  agencyId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: WalletLedgerRow[]; total: number }> {
  const t: Q = await getDb();
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = (await t
    .select({
      id: agencyWalletTransactions.id,
      kind: agencyWalletTransactions.kind,
      amountCents: agencyWalletTransactions.amountCents,
      balanceBeforeCents: agencyWalletTransactions.balanceBeforeCents,
      balanceAfterCents: agencyWalletTransactions.balanceAfterCents,
      currencyCode: agencyWalletTransactions.currencyCode,
      reason: agencyWalletTransactions.reason,
      reference: agencyWalletTransactions.reference,
      actorEmail: agencyWalletTransactions.actorEmail,
      applicationId: agencyWalletTransactions.applicationId,
      referenceLabel: visaApplications.reference,
      occurredAt: agencyWalletTransactions.occurredAt,
    })
    .from(agencyWalletTransactions)
    .leftJoin(visaApplications, eq(visaApplications.id, agencyWalletTransactions.applicationId))
    .where(eq(agencyWalletTransactions.agencyId, agencyId))
    .orderBy(sql`${agencyWalletTransactions.occurredAt} desc`)
    .limit(limit)
    .offset(offset)) as unknown as Array<Record<string, any>>;
  const count = (await t
    .select({ n: sql<number>`count(*)::int` })
    .from(agencyWalletTransactions)
    .where(eq(agencyWalletTransactions.agencyId, agencyId))) as Array<{ n: number }>;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: Number(r.amountCents),
      balanceBeforeCents: Number(r.balanceBeforeCents),
      balanceAfterCents: Number(r.balanceAfterCents),
      currencyCode: r.currencyCode,
      reason: r.reason,
      reference: r.reference ?? null,
      actorEmail: r.actorEmail ?? null,
      applicationId: r.applicationId ?? null,
      referenceLabel: r.referenceLabel ?? null,
      occurredAt: String(r.occurredAt),
    })),
    total: Number(count[0]?.n ?? 0),
  };
}

/** Cross-check every agency: header balance vs ledger sum. Used by the admin
 *  wallet page and by tests; a mismatch is a loud, actionable warning. */
export async function reconcileWallets(): Promise<Array<{ agencyId: string; agencyCode: string; balanceCents: number; ledgerSumCents: number; consistent: boolean }>> {
  const t: Q = await getDb();
  const rows = (await t
    .select({
      agencyId: agencies.id,
      agencyCode: agencies.code,
      balanceCents: agencies.walletBalanceCents,
      ledgerSumCents: sql<number>`coalesce(sum(${agencyWalletTransactions.amountCents}), 0)::bigint`,
    })
    .from(agencies)
    .leftJoin(agencyWalletTransactions, eq(agencyWalletTransactions.agencyId, agencies.id))
    .groupBy(agencies.id, agencies.code)) as unknown as Array<{
    agencyId: string;
    agencyCode: string;
    balanceCents: number;
    ledgerSumCents: string | number;
  }>;
  return rows.map((r) => ({
    agencyId: r.agencyId,
    agencyCode: r.agencyCode,
    balanceCents: Number(r.balanceCents),
    ledgerSumCents: Number(r.ledgerSumCents),
    consistent: Number(r.balanceCents) === Number(r.ledgerSumCents),
  }));
}

export async function outstandingBalancesByAgency(): Promise<Array<{ agencyId: string; agencyCode: string; agencyName: string; dueCents: number; currencyCode: string }>> {
  const t: Q = await getDb();
  const rows = (await t
    .select({
      agencyId: invoices.agencyId,
      agencyCode: agencies.code,
      agencyName: agencies.name,
      dueCents: sql<number>`coalesce(sum(${invoices.subtotalCents} - ${invoices.paidCents}), 0)::bigint`,
      currencyCode: invoices.currencyCode,
    })
    .from(invoices)
    .innerJoin(agencies, eq(agencies.id, invoices.agencyId))
    .where(inArray(invoices.status, ["PENDING", "PARTIALLY_PAID"]))
    .groupBy(invoices.agencyId, agencies.code, agencies.name, invoices.currencyCode)) as unknown as Array<{
    agencyId: string;
    agencyCode: string;
    agencyName: string;
    dueCents: string | number;
    currencyCode: string;
  }>;
  return rows.map((r) => ({ ...r, dueCents: Number(r.dueCents) }));
}
