import { ok, opRoute } from "@/lib/api-ops";
import { getWallet, listWalletLedger } from "@/lib/billing";
import { resolveAgencyContext } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET /api/agency/wallet — balance + ledger for the CALLER's agency.
 * There is deliberately no agencyId parameter: the tenant comes from the
 * session membership, so an agency cannot read another agency's money.
 */
export const GET = opRoute({ permission: "wallet.read", agencyFrom: "none" }, async ({ user, query }) => {
  const agencyId = await resolveAgencyContext(user);
  if (!agencyId) return ok({ agencyId: null, wallet: null, ledger: [] });
  const wallet = await getWallet(agencyId);
  const limit = Math.min(100, Number(query.get("limit") ?? 30) || 30);
  const offset = Math.max(0, Number(query.get("offset") ?? 0) || 0);
  const { rows, total } = await listWalletLedger(agencyId, { limit, offset });
  return ok({ agencyId, wallet, ledger: rows, total });
});
