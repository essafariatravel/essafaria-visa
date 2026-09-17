"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getSessionUser, SESSION_COOKIE } from "@/lib/session";
import { buildActor } from "@/lib/guard";
import { describeDomainError } from "@/lib/ops";
import { beginConnect, createConnection, disconnect, dismissInbound, draftReply, linkAttachmentToApplication, syncInbox } from "@/lib/gmail";
import { writeOAuthState } from "@/lib/oauth-state";
import { can } from "@/lib/rbac";

/* ============================================================
 * Gmail actions for the back office. Same shape as every other mutation here:
 * capability → validate → service. No token material is ever echoed back.
 * ============================================================ */

function flash(path: string, kind: "ok" | "err", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}flash=${encodeURIComponent(`${kind}:${message}`)}`);
}

async function gmailActor(permission: "gmail.manage" | "gmail.connect" | "applications.review") {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!can(user.role, permission)) flash("/admin/inbox", "err", "Not allowed");
  return buildActor(user, permission);
}

export async function createConnectionAction(fd: FormData): Promise<void> {
  const actor = await gmailActor("gmail.manage");
  try {
    await createConnection(actor, String(fd.get("label") ?? ""), String(fd.get("emailAddress") ?? ""));
    revalidatePath("/admin/inbox");
    flash("/admin/inbox", "ok", "Mailbox registered — connect it to start reading");
  } catch (err) {
    flash("/admin/inbox", "err", describeDomainError(err).message);
  }
}

export async function startConnectAction(fd: FormData): Promise<void> {
  const actor = await gmailActor("gmail.connect");
  const connectionId = String(fd.get("connectionId") ?? "");
  try {
    const { url, state, verifier } = await beginConnect(actor, connectionId);
    const token = cookies().get(SESSION_COOKIE)?.value ?? actor.id;
    writeOAuthState({ connectionId, state, verifier }, token);
    revalidatePath("/admin/inbox");
    // The operator is sent to the consent screen; the callback finishes the job.
    flash("/admin/inbox", "ok", `Authorisation URL ready for this mailbox — open it to grant read access: ${url.slice(0, 60)}…`);
  } catch (err) {
    flash("/admin/inbox", "err", describeDomainError(err).message);
  }
}

export async function syncMailboxAction(fd: FormData): Promise<void> {
  const actor = await gmailActor("gmail.manage");
  try {
    const res = await syncInbox(actor, String(fd.get("connectionId") ?? ""), { max: Number(fd.get("max") ?? 15) });
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/applications");
    flash(
      "/admin/inbox",
      res.error ? "err" : "ok",
      res.error
        ? `Sync failed: ${res.error}`
        : `Synced ${res.fetched} message(s): ${res.imported} imported, ${res.skipped} already known, ${res.unmatched} unmatched`,
    );
  } catch (err) {
    flash("/admin/inbox", "err", describeDomainError(err).message);
  }
}

export async function disconnectMailboxAction(fd: FormData): Promise<void> {
  const actor = await gmailActor("gmail.manage");
  try {
    await disconnect(actor, String(fd.get("connectionId") ?? ""));
    revalidatePath("/admin/inbox");
    flash("/admin/inbox", "ok", "Disconnected — the stored token was destroyed");
  } catch (err) {
    flash("/admin/inbox", "err", describeDomainError(err).message);
  }
}

export async function linkAttachmentAction(fd: FormData): Promise<void> {
  const actor = await gmailActor("applications.review");
  try {
    const res = await linkAttachmentToApplication(actor, {
      attachmentId: String(fd.get("attachmentId") ?? ""),
      applicationId: String(fd.get("applicationId") ?? ""),
      documentTypeCode: String(fd.get("documentTypeCode") ?? ""),
      applicantId: (fd.get("applicantId") as string) || null,
    });
    revalidatePath("/admin/inbox");
    flash(
      `/admin/applications/${fd.get("applicationId")}`,
      "ok",
      res.alreadyLinked ? "That attachment was already linked — nothing was duplicated" : "Attachment added to the file and put through the normal review queue",
    );
  } catch (err) {
    flash("/admin/inbox", "err", describeDomainError(err).message);
  }
}

export async function draftReplyAction(fd: FormData): Promise<void> {
  const actor = await gmailActor("communications.write" as never);
  try {
    const res = await draftReply(actor, {
      messageId: String(fd.get("messageId") ?? ""),
      body: String(fd.get("body") ?? ""),
    });
    revalidatePath("/admin/inbox");
    flash("/admin/inbox", "ok", `Draft ${res.draftId} created in the mailbox. Nothing was sent — a person must send it.`);
  } catch (err) {
    flash("/admin/inbox", "err", describeDomainError(err).message);
  }
}

export async function dismissMessageAction(fd: FormData): Promise<void> {
  const actor = await gmailActor("applications.review");
  try {
    await dismissInbound(actor, String(fd.get("messageId") ?? ""), (fd.get("note") as string) || null);
    revalidatePath("/admin/inbox");
    flash("/admin/inbox", "ok", "Cleared from the queue");
  } catch (err) {
    flash("/admin/inbox", "err", describeDomainError(err).message);
  }
}
