"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";
import { buildActor } from "@/lib/guard";
import { can } from "@/lib/rbac";
import { describeDomainError } from "@/lib/ops";
import { addTeamMember, removeTeamMember, setMemberRole, setPrimaryContact } from "@/lib/agency-team";
import { markAllRead, markNotificationRead } from "@/lib/notifications";

/* ============================================================
 * Agency portal actions. Role changes are validated against the AGENCY_*
 * subset here as well as in the service — a form must never be able to
 * escalate a partner user into a staff role.
 * ============================================================ */

function back(fd: FormData, fallback: string): string {
  const raw = fd.get("__back");
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw.slice(0, 200) : fallback;
}

function flash(path: string, kind: "ok" | "err", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}flash=${encodeURIComponent(`${kind}:${message}`)}`);
}

async function teamActor() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!can(user.role, "agencies.users.manage")) redirect("/login?error=forbidden");
  return buildActor(user, "agencies.users.manage");
}

const addSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().max(120).optional(),
  role: z.enum(["AGENCY_ADMIN", "AGENCY_USER"]),
  password: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(10).max(200).optional()),
});

export async function addTeamMemberAction(fd: FormData): Promise<void> {
  const path = back(fd, "/agency/team");
  const actor = await teamActor();
  const parsed = addSchema.safeParse({
    email: fd.get("email"),
    name: fd.get("name") || undefined,
    role: fd.get("role"),
    password: fd.get("password") || undefined,
  });
  if (!parsed.success) {
    flash(path, "err", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  try {
    const res = await addTeamMember(actor, { ...parsed.data, isPrimary: Boolean(fd.get("isPrimary")) });
    revalidatePath("/agency/team");
    flash(
      path,
      "ok",
      res.created
        ? res.tempPassword
          ? `Account created. Temporary password: ${res.tempPassword} — share it once and have them change it.`
          : "Account created and linked to your agency"
        : "Existing account linked to your agency",
    );
  } catch (err) {
    const { message } = describeDomainError(err);
    flash(path, "err", message);
  }
}

export async function setMemberRoleAction(fd: FormData): Promise<void> {
  const path = back(fd, "/agency/team");
  const actor = await teamActor();
  const userId = String(fd.get("userId") ?? "");
  const role = String(fd.get("role") ?? "");
  if (role !== "AGENCY_ADMIN" && role !== "AGENCY_USER") flash(path, "err", "Unknown role");
  try {
    await setMemberRole(actor, userId, role);
    revalidatePath(path);
    flash(path, "ok", "Role updated");
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function removeTeamMemberAction(fd: FormData): Promise<void> {
  const path = back(fd, "/agency/team");
  const actor = await teamActor();
  try {
    await removeTeamMember(actor, String(fd.get("userId") ?? ""));
    revalidatePath(path);
    flash(path, "ok", "Access removed — their history on the files they opened is preserved");
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function setPrimaryContactAction(fd: FormData): Promise<void> {
  const path = back(fd, "/agency/team");
  const actor = await teamActor();
  try {
    await setPrimaryContact(actor, String(fd.get("userId") ?? ""));
    revalidatePath(path);
    flash(path, "ok", "Primary contact updated");
  } catch (err) {
    flash(path, "err", describeDomainError(err).message);
  }
}

export async function markAllReadAction(): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  await markAllRead({ id: user.id, agencyIds: user.agencyIds });
  revalidatePath("/agency/inbox");
  revalidatePath("/agency");
  redirect("/agency/inbox");
}

export async function markOneReadAction(fd: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const path = back(fd, "/agency/inbox");
  const changed = await markNotificationRead({
    id: String(fd.get("id") ?? ""),
    userId: user.id,
    agencyIds: user.agencyIds,
  });
  revalidatePath(path);
  if (!changed) flash(path, "err", "That notification is not yours (or already read)");
  redirect(path);
}
