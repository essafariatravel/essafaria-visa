import { and, desc, eq, sql } from "drizzle-orm";
import { ok, opRoute } from "@/lib/api-ops";
import { getDb, invoiceItems, invoices } from "@/db";
import { resolveAgencyContext } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

type Q = any;

/** GET /api/agency/invoices — the caller's invoices with their lines. */
export const GET = opRoute({ permission: "invoices.read", agencyFrom: "none" }, async ({ user }) => {
  const agencyId = await resolveAgencyContext(user);
  if (!agencyId) return ok({ invoices: [] });
  const t: Q = await getDb();
  const rows = (await t
    .select()
    .from(invoices)
    .where(eq(invoices.agencyId, agencyId))
    .orderBy(desc(invoices.createdAt))
    .limit(50)) as Array<typeof invoices.$inferSelect>;
  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? ((await t
        .select()
        .from(invoiceItems)
        .where(sql`${invoiceItems.invoiceId} in (${sql.join(ids.map((i) => sql`${i}`), sql`,`)})`)) as Array<typeof invoiceItems.$inferSelect>)
    : [];
  return ok({
    invoices: rows.map((r) => ({
      number: r.number,
      status: r.status,
      currencyCode: r.currencyCode,
      subtotalCents: Number(r.subtotalCents),
      paidCents: Number(r.paidCents),
      balanceDueCents: Number(r.subtotalCents) - Number(r.paidCents),
      issuedAt: r.issuedAt ? String(r.issuedAt) : null,
      applicationId: r.applicationId,
      items: items
        .filter((i) => i.invoiceId === r.id)
        .map((i) => ({
          description: i.description,
          feeType: i.feeType,
          quantity: i.quantity,
          unitAmountCents: Number(i.unitAmountCents),
          amountCents: Number(i.amountCents),
          chargeStatus: i.chargeStatus,
        })),
    })),
  });
});
