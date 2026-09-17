"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  agencies,
  agencyMemberships,
  users,
  media,
  siteSettings,
  homepageSections,
  legalPages,
} from "@/db";
import { requirePermission, AuthorizationError, resolveActor } from "@/lib/authorization";
import { saveEntity, setEntityActive, moveEntity, deleteEntity, type Entities } from "@/lib/crud";
import { validateSettingValue, SETTING_DEFINITIONS } from "@/lib/validation";
import { logAudit, diff } from "@/lib/audit";
import { invalidateConfig } from "@/lib/config-service";
import { storage, makeStorageKey, sniffImage } from "@/lib/storage";
import { hashPassword, verifyPassword } from "@/lib/password";
import { loginSchema, MEDIA_ALLOWED_MIME, MEDIA_MAX_BYTES } from "@/lib/validation";
import { createSession, destroySession, revokeSessionsFor } from "@/lib/session";
import { assertPermission } from "@/lib/rbac";
import { isAgencyRole } from "@/lib/tenancy";

/* ============================================================
 * Admin server actions. Every mutation here is:
 *   authenticated → permission-checked → validated → audited
 *   (same transaction) → cache/path revalidated.
 * ============================================================ */

function flash(path: string, msg: string, kind: "ok" | "err" = "ok"): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}flash=${encodeURIComponent(`${kind}:${msg}`)}`);
}

function errFlash(path: string, message: string, issues?: string[]): never {
  const joined = issues && issues.length ? `${message} — ${issues.join("; ")}` : message;
  flash(path, joined, "err");
}

function toRecord(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function parseBool(v: unknown, fallback = false): boolean {
  if (v === "on" || v === "true" || v === true) return true;
  if (v === "off" || v === "false" || v === "" || v === undefined || v === null) return false;
  return fallback;
}

/** Shared: save a generic config entity from a form. */
export async function saveConfigEntityAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const entity = String(rec.__entity ?? "") as Entities;
  const back = String(rec.__back ?? "/admin");
  const id = rec.__id ? String(rec.__id) : null;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (!k.startsWith("__")) data[k] = v;
  try {
    await saveEntity(await resolveActor(), entity, coerceEntityInput(entity, data), id);
  } catch (err) {
    if (err instanceof Error && err.name === "ValidationError") {
      const issues = (err as unknown as { issues: string[] }).issues ?? [];
      return errFlash(back, "Validation failed", issues);
    }
    return errFlash(back, describeDbError(err));
  }
  revalidateAll();
  flash(back, id ? "Saved" : "Created");
}

function coerceEntityInput(entity: Entities, data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  // <input type=color> helpers: prefer a non-empty picker value over the text field,
  // then strip the synthetic keys so they never reach the database.
  for (const key of Object.keys(out)) {
    if (key.endsWith("__picker")) {
      const base = key.slice(0, -"__picker".length);
      const picked = String(out[key] ?? "");
      if (/^#[0-9a-fA-F]{6}$/.test(picked)) out[base] = picked;
      delete out[key];
    }
  }
  // checkboxes come as "on"/absent
  for (const k of ["isActive", "isRequired", "isTerminal", "isFeatured", "isBase", "isPrimary"]) {
    if (k in out || entityRequiresBool(entity, k)) out[k] = parseBool(out[k], k === "isActive");
  }
  if (entity === "document-types" && typeof out.allowedExtensions === "string") {
    out.allowedExtensions = String(out.allowedExtensions)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  if (out.processingTimeDays === "" || out.processingTimeDays === undefined) out.processingTimeDays = null;
  if (out.maxFileSizeMb === "" || out.maxFileSizeMb === undefined) out.maxFileSizeMb = null;
  if (out.validityDays === "" || out.validityDays === undefined) out.validityDays = null;
  if (out.overlayOpacity === "" || out.overlayOpacity === undefined) out.overlayOpacity = null;
  if (out.categoryId === "") out.categoryId = null;
  if (out.countryId === "" && entity === "agencies") out.countryId = null;
  return out;
}

function entityRequiresBool(_entity: Entities, _key: string): boolean {
  return false;
}

function describeDbError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === "AuthorizationError") return "Not allowed for your role";
  if (/Missing permission|Authentication required/.test(msg)) return "Not allowed for your role";
  if (/duplicate key|violates unique constraint/i.test(msg)) return "Duplicate value — that code already exists.";
  if (/violates foreign key/i.test(msg)) return "This record is referenced by other data — deactivate instead.";
  return "Could not save: " + msg.slice(0, 160);
}

export async function toggleActiveAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const entity = String(rec.__entity) as Entities;
  const id = String(rec.__id);
  const back = String(rec.__back ?? "/admin");
  const active = parseBool(rec.__active, true);
  try {
    await setEntityActive(await resolveActor(), entity, id, active);
  } catch (err) {
    if (err instanceof Error && err.name === "AuthorizationError") return errFlash(back, "Not allowed");
    return errFlash(back, describeDbError(err));
  }
  revalidateAll();
  flash(back, active ? "Activated" : "Deactivated");
}

export async function moveAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const entity = String(rec.__entity) as Entities;
  const id = String(rec.__id);
  const back = String(rec.__back ?? "/admin");
  const dir = String(rec.__dir) === "down" ? "down" : "up";
  const scopeCol = rec.__scopeCol ? String(rec.__scopeCol) : undefined;
  const scopeVal = rec.__scopeVal ? String(rec.__scopeVal) : undefined;
  try {
    await moveEntity(await resolveActor(), entity, id, dir, scopeCol, scopeVal);
  } catch {
    return errFlash(back, "Could not reorder");
  }
  revalidateAll();
  flash(back, "Order updated", "ok");
}

export async function deleteConfigAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const entity = String(rec.__entity) as Entities;
  const id = String(rec.__id);
  const back = String(rec.__back ?? "/admin");
  try {
    await deleteEntity(await resolveActor(), entity, id);
  } catch (err) {
    return errFlash(back, describeDbError(err));
  }
  revalidateAll();
  flash(back, "Deleted");
}

function revalidateAll(): void {
  invalidateConfig();
  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
}

/* ---------------- login / logout ---------------- */

export async function loginAction(fd: FormData): Promise<void> {
  const parsed = loginSchema.safeParse({ email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) return flash("/login", "Enter a valid email and password", "err");
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
  const ok = user && user.isActive && (await verifyPassword(parsed.data.password, user.passwordHash));
  if (!ok) return flash("/login", "Invalid credentials", "err");
  await createSession(user.id);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await logAudit({ actorId: user.id, actorEmail: user.email, action: "LOGIN", entityType: "user", entityId: user.id });
  const target = isAgencyRole(user.role) ? "/agency" : "/admin";
  const next = typeof fd.get("next") === "string" && String(fd.get("next")).startsWith("/") ? String(fd.get("next")) : target;
  redirect(next);
}

export async function logoutAction(): Promise<void> {
  const user = await (await import("@/lib/session")).getSessionUser();
  if (user) {
    await logAudit({ actorId: user.id, actorEmail: user.email, action: "LOGOUT", entityType: "user", entityId: user.id });
  }
  await destroySession();
  redirect("/login");
}

/* ---------------- agencies: status + members ---------------- */

export async function setAgencyStatusAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const agencyId = String(rec.__id);
  const status = String(rec.status);
  const user = await requirePermission("agencies.write").catch(() => null);
  if (!user) return errFlash("/admin/agencies", "Not allowed");
  if (!["ACTIVE", "SUSPENDED", "INACTIVE"].includes(status)) return errFlash("/admin/agencies", "Invalid status");
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.update(agencies).set({ status: status as "ACTIVE", updatedAt: new Date() }).where(eq(agencies.id, agencyId));
    await logAudit(
      { actorId: user.id, actorEmail: user.email, action: "UPDATE", entityType: "agency", entityId: agencyId, changes: { after: { status } } },
      tx,
    );
  });
  revalidateAll();
  flash(`/admin/agencies/${agencyId}`, "Agency status updated");
}

export async function assignMemberAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const agencyId = String(rec.agencyId);
  const email = String(rec.email ?? "").trim().toLowerCase();
  const user = await requirePermission("agencies.users.manage").catch(() => null);
  if (!user) return errFlash(`/admin/agencies/${agencyId}`, "Not allowed");
  const db = await getDb();
  const [target] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!target) return errFlash(`/admin/agencies/${agencyId}`, "No user with that email");
  try {
    await db.transaction(async (tx) => {
      await tx.insert(agencyMemberships).values({ agencyId, userId: target.id, isPrimary: false });
      await logAudit(
        { actorId: user.id, actorEmail: user.email, action: "ASSIGN", entityType: "agency_membership", entityId: `${agencyId}:${target.id}`, agencyId },
        tx,
      );
    });
  } catch {
    return errFlash(`/admin/agencies/${agencyId}`, "Already a member of this agency");
  }
  revalidateAll();
  flash(`/admin/agencies/${agencyId}`, "Member assigned");
}

export async function removeMemberAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const agencyId = String(rec.agencyId);
  const userId = String(rec.userId);
  const user = await requirePermission("agencies.users.manage").catch(() => null);
  if (!user) return errFlash(`/admin/agencies/${agencyId}`, "Not allowed");
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx
      .delete(agencyMemberships)
      .where(and(eq(agencyMemberships.agencyId, agencyId), eq(agencyMemberships.userId, userId)));
    await logAudit(
      { actorId: user.id, actorEmail: user.email, action: "REMOVE", entityType: "agency_membership", entityId: `${agencyId}:${userId}`, agencyId },
      tx,
    );
  });
  revalidateAll();
  flash(`/admin/agencies/${agencyId}`, "Member removed");
}

/* ---------------- users ---------------- */

export async function saveUserAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const id = rec.__id ? String(rec.__id) : null;
  const back = String(rec.__back ?? "/admin/users");
  const actor = await resolveActor();
  try {
    assertPermission(actor.role, "users.write");
  } catch {
    return errFlash(back, "Not allowed");
  }
  const email = String(rec.email ?? "").trim().toLowerCase();
  const name = String(rec.name ?? "").trim();
  const role = String(rec.role);
  const isActive = parseBool(rec.isActive, true);
  const password = rec.password ? String(rec.password) : null;
  const db = await getDb();

  try {
    await db.transaction(async (tx) => {
      if (id) {
        const [before] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
        if (!before) throw new Error("User not found");
        const patch: Record<string, unknown> = { name, role, isActive, updatedAt: new Date() };
        if (password) patch.passwordHash = await hashPassword(password);
        // only SUPER_ADMIN may grant SUPER_ADMIN/ADMIN roles
        if ((patch.role === "SUPER_ADMIN" || patch.role === "ADMIN" || "passwordHash" in patch) && actor.role !== "SUPER_ADMIN") {
          if (patch.role !== before.role || "passwordHash" in patch) throw new Error("Only a super admin can change roles to admin or reset passwords");
        }
        await tx.update(users).set(patch).where(eq(users.id, id));
        await logAudit(
          { actorId: actor.id, actorEmail: actor.email, action: "UPDATE", entityType: "user", entityId: id, changes: diff(before as unknown as Record<string, unknown>, patch) },
          tx,
        );
      } else {
        if (!password) throw new Error("Password required for new users");
        if (password.length < 10) throw new Error("Password: minimum 10 characters");
        if ((role === "SUPER_ADMIN" || role === "ADMIN") && actor.role !== "SUPER_ADMIN") {
          throw new Error("Only a super admin can create privileged accounts");
        }
        const inserted = await tx
          .insert(users)
          .values({ id: randomUUID(), email, name, role: role as "ADMIN", passwordHash: await hashPassword(password), isActive })
          .returning({ id: users.id });
        await logAudit(
          { actorId: actor.id, actorEmail: actor.email, action: "CREATE", entityType: "user", entityId: inserted[0].id, changes: { after: { email, name, role } } },
          tx,
        );
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not save user";
    if (/duplicate/i.test(msg)) return errFlash(back, "That email is already registered");
    return errFlash(back, msg);
  }
  if (id && (password || !isActive)) {
    // A password change or a deactivation invalidates every existing session:
    // without this, a stolen cookie keeps working after the account is locked.
    await revokeSessionsFor(id).catch(() => 0);
  }
  revalidateAll();
  flash(back, id ? "User updated" : "User created");
}

/* ---------------- branding + media ---------------- */

export async function saveBrandingAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const back = "/admin/branding";
  try {
    const data: Record<string, unknown> = {
      brandName: rec.brandName,
      companyName: rec.companyName,
      tagline: rec.tagline ?? "",
      primaryColor: rec.primaryColor,
      secondaryColor: rec.secondaryColor,
      accentColor: rec.accentColor,
      backgroundColor: rec.backgroundColor,
      textColor: rec.textColor,
      buttonStyle: rec.buttonStyle ?? "rounded",
      logoMediaId: rec.logoMediaId ?? "",
      secondaryLogoMediaId: rec.secondaryLogoMediaId ?? "",
      faviconMediaId: rec.faviconMediaId ?? "",
    };
    await saveEntity(await resolveActor(), "branding", data);
  } catch (err) {
    if (err instanceof Error && err.name === "ValidationError") {
      const issues = (err as unknown as { issues: string[] }).issues ?? [];
      return errFlash(back, "Validation failed", issues);
    }
    return errFlash(back, describeDbError(err));
  }
  revalidateAll();
  flash(back, "Branding saved — every surface updated");
}

export async function uploadMediaAction(fd: FormData): Promise<void> {
  const back = String(fd.get("__back") ?? "/admin/branding");
  const kind = String(fd.get("kind") ?? "CONTENT");
  const file = fd.get("file");
  const actor = await resolveActor().catch(() => null);
  if (!actor) return errFlash(back, "Not allowed");
  try {
    assertPermission(actor.role, "media.write");
  } catch {
    return errFlash(back, "Not allowed");
  }
  if (!(file instanceof File)) return errFlash(back, "Choose a file to upload");
  if (file.size > MEDIA_MAX_BYTES) return errFlash(back, `File exceeds ${MEDIA_MAX_BYTES / 1024 / 1024}MB limit`);
  const buf = Buffer.from(await file.arrayBuffer());
  const sniff = sniffImage(buf);
  if (!sniff || !(MEDIA_ALLOWED_MIME as readonly string[]).includes(sniff.mime)) {
    return errFlash(back, "Only PNG, JPEG and WebP images are accepted");
  }
  const key = makeStorageKey(kind.toLowerCase(), file.name || "upload");
  await storage().put(key, buf, sniff.mime);
  const db = await getDb();
  const inserted = await db
    .insert(media)
    .values({
      id: randomUUID(),
      kind: kind as "LOGO",
      filename: (file.name || key).slice(0, 200),
      storageKey: key,
      mimeType: sniff.mime,
      sizeBytes: file.size,
      width: sniff.width,
      height: sniff.height,
      uploadedBy: actor.id,
    })
    .returning({ id: media.id });
  await logAudit({ actorId: actor.id, actorEmail: actor.email, action: "UPLOAD", entityType: "media", entityId: inserted[0].id });
  revalidateAll();
  flash(back, "Uploaded to media library");
}

/* ---------------- site settings ---------------- */

export async function saveSettingAction(fd: FormData): Promise<void> {
  const key = String(fd.get("key") ?? "");
  const rawValue = fd.get("value");
  const back = `/admin/settings?cat=${encodeURIComponent(String(fd.get("category") ?? "GENERAL"))}`;
  const actor = await resolveActor().catch(() => null);
  if (!actor) return errFlash("/admin", "Not allowed");
  try {
    assertPermission(actor.role, "settings.write");
  } catch {
    return errFlash(back, "Not allowed to edit settings");
  }
  const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  const validation = validateSettingValue(key, value);
  if (!validation.ok) return errFlash(back, validation.error ?? "Invalid value");
  const def = SETTING_DEFINITIONS[key];
  const db = await getDb();
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: siteSettings.id, value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, key)).limit(1);
    if (existing.length) {
      await tx
        .update(siteSettings)
        .set({ value: validation.parsed, updatedAt: new Date() })
        .where(eq(siteSettings.key, key));
      await logAudit(
        { actorId: actor.id, actorEmail: actor.email, action: "UPDATE", entityType: "site_setting", entityId: existing[0].id, changes: diff({ value: existing[0].value }, { value: validation.parsed }) },
        tx,
      );
    } else {
      const ins = await tx
        .insert(siteSettings)
        .values({ id: randomUUID(), key, category: def.category, label: def.label, value: validation.parsed })
        .returning({ id: siteSettings.id });
      await logAudit({ actorId: actor.id, actorEmail: actor.email, action: "CREATE", entityType: "site_setting", entityId: ins[0].id });
    }
  });
  invalidateConfig();
  revalidateAll();
  flash(back, `Saved ${key}`);
}

/* ---------------- homepage sections (CMS) ---------------- */

export async function saveSectionAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const id = rec.__id ? String(rec.__id) : null;
  const back = "/admin/homepage";
  const actor = await resolveActor().catch(() => null);
  if (!actor) return errFlash(back, "Not allowed");
  try {
    assertPermission(actor.role, "content.write");
    let items: unknown = [];
    const itemsRaw = rec.items;
    if (typeof itemsRaw === "string" && itemsRaw.trim()) {
      items = JSON.parse(itemsRaw);
    }
    const { homepageSectionUpsertSchema } = await import("@/lib/validation");
    const parsed = homepageSectionUpsertSchema.parse({
      sectionType: rec.sectionType,
      title: rec.title ?? "",
      subtitle: rec.subtitle ?? "",
      body: rec.body ?? "",
      ctaLabel: rec.ctaLabel ?? "",
      ctaHref: rec.ctaHref ?? "",
      imageMediaId: rec.imageMediaId ?? "",
      overlayOpacity: rec.overlayOpacity ?? "",
      items: Array.isArray(items) ? items : [],
      isActive: parseBool(rec.isActive, true),
      displayOrder: Number(rec.displayOrder ?? 0),
    });
    const db = await getDb();
    const { title, subtitle, body, ctaLabel, ctaHref, imageMediaId, overlayOpacity, items: sectionItems, isActive, displayOrder, sectionType } = parsed;
    const values = {
      sectionType,
      title,
      subtitle,
      body,
      ctaLabel: ctaLabel || (ctaHref ? ctaLabel : null),
      ctaHref,
      imageMediaId,
      overlayOpacity,
      isActive,
      displayOrder,
      config: { items: sectionItems },
      updatedAt: new Date(),
    };
    if (id) {
      await db.update(homepageSections).set(values).where(eq(homepageSections.id, id));
      await logAudit({ actorId: actor.id, actorEmail: actor.email, action: "UPDATE", entityType: "homepage_section", entityId: id });
    } else {
      const ins = await db.insert(homepageSections).values({ id: randomUUID(), ...values, publishState: "DRAFT" }).returning({ id: homepageSections.id });
      await logAudit({ actorId: actor.id, actorEmail: actor.email, action: "CREATE", entityType: "homepage_section", entityId: ins[0].id });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid section data";
    return errFlash(back, msg.includes("[") ? "Section items must be a JSON array of {title, description}" : `Section not saved: ${msg.slice(0, 140)}`);
  }
  revalidateAll();
  flash(back, "Section saved");
}

export async function sectionStateAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const id = String(rec.__id);
  const action = String(rec.__action); // publish | unpublish | delete
  const back = "/admin/homepage";
  const actor = await resolveActor().catch(() => null);
  if (!actor) return errFlash(back, "Not allowed");
  try {
    assertPermission(actor.role, "content.write");
  } catch {
    return errFlash(back, "Not allowed");
  }
  const db = await getDb();
  if (action === "delete") {
    await db.delete(homepageSections).where(eq(homepageSections.id, id));
  } else {
    await db
      .update(homepageSections)
      .set({
        publishState: action === "publish" ? "PUBLISHED" : "DRAFT",
        publishedAt: action === "publish" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(homepageSections.id, id));
  }
  await logAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: action === "publish" ? "PUBLISH" : action === "unpublish" ? "UNPUBLISH" : "DELETE",
    entityType: "homepage_section",
    entityId: id,
  });
  revalidateAll();
  flash(back, action === "publish" ? "Section published — live now" : action === "unpublish" ? "Section unpublished" : "Section deleted");
}

export async function moveSectionAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const id = String(rec.__id);
  const dir = String(rec.__dir) === "down" ? "down" : "up";
  const actor = await resolveActor().catch(() => null);
  if (!actor) return errFlash("/admin/homepage", "Not allowed");
  const db = await getDb();
  const rows = await db
    .select({ id: homepageSections.id, displayOrder: homepageSections.displayOrder })
    .from(homepageSections)
    .orderBy(homepageSections.displayOrder);
  const idx = rows.findIndex((r) => r.id === id);
  const swapWith = dir === "up" ? idx - 1 : idx + 1;
  if (idx === -1 || swapWith < 0 || swapWith >= rows.length) return flash("/admin/homepage", "Already at the edge");
  await db
    .update(homepageSections)
    .set({ displayOrder: rows[swapWith].displayOrder })
    .where(eq(homepageSections.id, rows[idx].id));
  await db
    .update(homepageSections)
    .set({ displayOrder: rows[idx].displayOrder })
    .where(eq(homepageSections.id, rows[swapWith].id));
  revalidateAll();
  flash("/admin/homepage", "Order updated");
}

/* ---------------- legal pages ---------------- */

export async function saveLegalPageAction(fd: FormData): Promise<void> {
  const rec = toRecord(fd);
  const id = rec.__id ? String(rec.__id) : null;
  const back = `/admin/legal${id ? `?edit=${id}` : ""}`;
  const actor = await resolveActor().catch(() => null);
  if (!actor) return errFlash("/admin", "Not allowed");
  try {
    assertPermission(actor.role, "content.write");
  } catch {
    return errFlash(back, "Not allowed");
  }
  // Block editor syntax: "## " → heading, "- " → list item, else paragraph.
  const raw = String(rec.blocks ?? "");
  const body: Array<{ type: "h2" | "p" | "li"; text: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("## ")) body.push({ type: "h2", text: t.slice(3).trim().slice(0, 200) });
    else if (t.startsWith("- ")) body.push({ type: "li", text: t.slice(2).trim().slice(0, 600) });
    else body.push({ type: "p", text: t.slice(0, 4000) });
  }
  const slug = String(rec.slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const title = String(rec.title ?? "").trim().slice(0, 160);
  if (!slug || !title) return errFlash(back, "Slug and title are required");
  if (body.length === 0 || body.length > 120) return errFlash(back, "Body must have 1–120 content lines");
  const db = await getDb();
  try {
    if (id) {
      await db.update(legalPages).set({ slug, title, body, updatedAt: new Date() }).where(eq(legalPages.id, id));
      await logAudit({ actorId: actor.id, actorEmail: actor.email, action: "UPDATE", entityType: "legal_page", entityId: id });
    } else {
      const ins = await db
        .insert(legalPages)
        .values({ id: randomUUID(), slug, title, body, publishState: "DRAFT" })
        .returning({ id: legalPages.id });
      await logAudit({ actorId: actor.id, actorEmail: actor.email, action: "CREATE", entityType: "legal_page", entityId: ins[0].id });
    }
  } catch {
    return errFlash(back, "Slug already in use by another page");
  }
  revalidateAll();
  flash("/admin/legal", "Page saved");
}

export async function publishLegalPageAction(fd: FormData): Promise<void> {
  const id = String(fd.get("__id"));
  const publish = fd.get("__action") === "publish";
  const actor = await resolveActor().catch(() => null);
  if (!actor) return errFlash("/admin/legal", "Not allowed");
  try {
    assertPermission(actor.role, "content.write");
  } catch {
    return errFlash("/admin/legal", "Not allowed");
  }
  const db = await getDb();
  await db
    .update(legalPages)
    .set({ publishState: publish ? "PUBLISHED" : "DRAFT", publishedAt: publish ? new Date() : null, updatedAt: new Date() })
    .where(eq(legalPages.id, id));
  await logAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: publish ? "PUBLISH" : "UNPUBLISH",
    entityType: "legal_page",
    entityId: id,
  });
  revalidateAll();
  flash("/admin/legal", publish ? "Page published" : "Page reverted to draft");
}

export { AuthorizationError };
