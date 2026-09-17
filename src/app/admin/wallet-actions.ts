"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";
import { buildStaffActor } from "@/lib/guard";
import { describeDomainError } from "@/lib/ops";
import { adjustWallet, chargeApplication, creditWallet, reverseWalletTransaction, voidInvoice } from "@/lib/billing";
import { dispatchDueEmails } from "@/lib/notifications";

/* ============================================================
 * Money actions for the back office. Each one: staff capability → validation
 * → service (which re-checks the capability, proves the tenant relationship,
 * moves the balance conditionally and writes the ledger + audit + notification
 * in one transaction). Amounts are entered in whole currency units and
 * converted to integer cents here — never multiplied by a float later.
 * ============================================================ */

function flash(path: string, kind: "ok" | "err", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}flash=${encodeURIComponent(`${kind}:${message}`)}`);
}

function toCents(input: string | null | undefined): number {
  const raw = String(input ?? "").trim().replace(/\s/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) throw new Error("Enter an amount like 250 or 250.50 (max two decimals)");
  const negative = raw.startsWith("-");
  const [whole, frac = ""] = raw.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new Error("Amount out of range");
  return negative ? -cents : cents;
}

async function staffActor(permission: Parameters<typeof buildStaffActor>[1]) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return buildStaffActor(user, permission);
}

const creditSchema = z.object({
  agencyId: z.string().trim().min(1).max(64),
  currencyCode: z.string().trim().regex(/^[A-Z]{3}$/),
  reason: z.string().trim().min(5).max(500),
  reference: z.string().trim().max(120).optional(),
});

export async function creditWalletAction(fd: FormData): Promise<void> {
  const path = "/admin/wallet";
  let actor: Awaited<ReturnType<typeof staffActor>>;
  try {
    actor = await staffActor("wallet.write");
  } catch {
    redirect("/login");
  }
  let amountCents: number;
  try {
    amountCents = toCents(fd.get("amount") as string);
  } catch (err) {
    flash(path, "err", (err as Error).message);
  }
  const parsed = creditSchema.safeParse({
    agencyId: fd.get("agencyId"),
    currencyCode: String(fd.get("currencyCode") ?? "").toUpperCase(),
    reason: fd.get("reason"),
    reference: (fd.get("reference") as string) || undefined,
  });
  if (!parsed.success) {
    flash(path, "err", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  try {
    const res = await creditWallet(actor, {
      ...parsed.data,
      amountCents: amountCents!,
      reference: parsed.data.reference ?? null,
      // a re-submitted form must not double-fund the same bank transfer
      idempotencyKey: (fd.get("idempotencyKey") as string) || `CREDIT:${Date.now()}:${actor.id}`,
    });
    revalidatePath("/admin/wallet");
    revalidatePath("/agency/wallet");
    flash(
      path,
      "ok",
      res.deduped
        ? "Already recorded — this idempotency key was used before, so nothing was added twice"
        : `Credited. New balance ${(res.balanceAfterCents / 100).toFixed(2)}`,
    );
  } catch (err) {
    const { message, issues } = describeDomainError(err);
    flash(path, "err", issues?.length ? `${message} — ${issues.join("; ")}` : message);
  }
}

export async function adjustWalletAction(fd: FormData): Promise<void> {
  const path = "/admin/wallet";
  const actor = await staffActor("wallet.write");
  let amountCents: number;
  try {
    amountCents = toCents(fd.get("amount") as string);
  } catch (err) {
    flash(path, "err", (err as Error).message);
  }
  const kind = String(fd.get("kind") ?? "ADJUSTMENT");
  try {
    const res = await adjustWallet(actor, {
      agencyId: String(fd.get("agencyId") ?? ""),
      amountCents: amountCents!,
      kind: kind === "REFUND" ? "REFUND" : "ADJUSTMENT",
      currencyCode: String(fd.get("currencyCode") ?? "EUR").toUpperCase(),
      reason: String(fd.get("reason") ?? ""),
      reference: (fd.get("reference") as string) || null,
      idempotencyKey: (fd.get("idempotencyKey") as string) || null,
    });
    revalidatePath(path);
    flash(path, "ok", `Recorded. Balance ${(res.balanceAfterCents / 100).toFixed(2)}`);
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function chargeNowAction(fd: FormData): Promise<void> {
  const applicationId = String(fd.get("applicationId") ?? "");
  const path = String(fd.get("__back") ?? `/admin/applications/${applicationId}`);
  let actor: Awaited<ReturnType<typeof staffActor>>;
  try {
    actor = await staffActor("wallet.charge");
  } catch {
    redirect("/login");
  }
  try {
    // No fixed per-file key here: the service derives one from the exact invoice
    // lines being settled, so a double click is absorbed while a deliberate
    // re-charge after a reversal is allowed.
    const res = await chargeApplication(actor, applicationId, {
      idempotencyKey: (fd.get("idempotencyKey") as string) || undefined,
    });
    revalidatePath(path);
    revalidatePath("/admin/wallet");
    flash(
      path,
      "ok",
      res.alreadyCharged
        ? "Nothing to charge — every line was already settled (no double charge)"
        : `Charged ${(res.chargedCents / 100).toFixed(2)}; balance now ${(res.balanceAfterCents / 100).toFixed(2)}`,
    );
  } catch (err) {
    const { message, issues } = describeDomainError(err);
    flash(path, "err", issues?.length ? `${message} — ${issues.join("; ")}` : message);
  }
}

export async function reverseChargeAction(fd: FormData): Promise<void> {
  const path = String(fd.get("__back") ?? "/admin/wallet");
  const actor = await staffActor("wallet.write");
  try {
    const res = await reverseWalletTransaction(actor, {
      walletTxId: String(fd.get("walletTxId") ?? ""),
      reason: String(fd.get("reason") ?? ""),
    });
    revalidatePath("/admin/wallet");
    flash(path, "ok", `Reversed. Balance ${(res.balanceAfterCents / 100).toFixed(2)}`);
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function voidInvoiceAction(fd: FormData): Promise<void> {
  const path = String(fd.get("__back") ?? "/admin/wallet");
  const actor = await staffActor("wallet.write");
  try {
    await voidInvoice(actor, String(fd.get("invoiceId") ?? ""), String(fd.get("reason") ?? ""));
    revalidatePath(path);
    flash(path, "ok", "Invoice voided");
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function drainOutboxAction(fd: FormData): Promise<void> {
  const path = String(fd.get("__back") ?? "/admin/wallet");
  try {
    await staffActor("notifications.send");
  } catch {
    redirect("/login");
  }
  const res = await dispatchDueEmails(25);
  revalidatePath(path);
  flash(path, "ok", `Outbox: claimed ${res.claimed}, sent ${res.sent}, failed ${res.failed}`);
}
