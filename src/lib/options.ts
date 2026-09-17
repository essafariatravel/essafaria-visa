import { asc, eq } from "drizzle-orm";
import { agencies, getDb, priorities, users, visaTypes, countries } from "@/db";

type Q = any;

/* ============================================================
 * Option lists for operational forms.
 *
 * Every dropdown is a live query against configuration — so a newly created
 * country, visa route, priority or staff account appears in the UI without a
 * code change (and a deactivated one disappears).
 * ============================================================ */

export async function agencyOptions(): Promise<Array<{ value: string; label: string }>> {
  const t: Q = await getDb();
  const rows = (await t
    .select({ id: agencies.id, name: agencies.name, code: agencies.code, status: agencies.status })
    .from(agencies)
    .where(eq(agencies.status, "ACTIVE"))
    .orderBy(asc(agencies.name))) as Array<{ id: string; name: string; code: string; status: string }>;
  return rows.map((r) => ({ value: r.id, label: `${r.name} (${r.code})` }));
}

export async function visaTypeOptions(): Promise<Array<{ value: string; label: string; code: string }>> {
  const t: Q = await getDb();
  const rows = (await t
    .select({
      id: visaTypes.id,
      code: visaTypes.code,
      name: visaTypes.name,
      country: countries.name,
      days: visaTypes.processingTimeDays,
    })
    .from(visaTypes)
    .innerJoin(countries, eq(countries.id, visaTypes.countryId))
    .where(eq(visaTypes.isActive, true))
    .orderBy(asc(visaTypes.displayOrder), asc(visaTypes.name))) as Array<{ id: string; code: string; name: string; country: string; days: number | null }>;
  return rows.map((r) => ({
    value: r.id,
    code: r.code,
    label: `${r.name} — ${r.country}${r.days ? ` · ${r.days} days` : ""}`,
  }));
}

export async function priorityOptions(): Promise<Array<{ value: string; label: string }>> {
  const t: Q = await getDb();
  const rows = (await t
    .select({ id: priorities.id, label: priorities.label, surchargePercent: priorities.surchargePercent })
    .from(priorities)
    .where(eq(priorities.isActive, true))
    .orderBy(asc(priorities.displayOrder))) as Array<{ id: string; label: string; surchargePercent: number }>;
  return rows.map((r) => ({ value: r.id, label: r.surchargePercent ? `${r.label} (+${r.surchargePercent}%)` : r.label }));
}

/** Document types available to an upload picker (live configuration). */
export async function documentTypeOptions(): Promise<Array<{ value: string; label: string; code: string }>> {
  const { documentTypes } = await import("@/db");
  const t: Q = await getDb();
  const rows = (await t
    .select({ id: documentTypes.id, code: documentTypes.code, name: documentTypes.name })
    .from(documentTypes)
    .where(eq(documentTypes.isActive, true))
    .orderBy(asc(documentTypes.displayOrder))) as Array<{ id: string; code: string; name: string }>;
  return rows.map((r) => ({ value: r.id, code: r.code, label: r.name }));
}

export async function staffOptions(): Promise<Array<{ value: string; label: string }>> {
  const { can } = await import("@/lib/rbac");
  const t: Q = await getDb();
  const rows = (await t
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(asc(users.name))) as Array<{ id: string; name: string; role: string }>;
  return rows
    .filter((r) => can(r.role as never, "applications.read"))
    .map((r) => ({ value: r.id, label: `${r.name} · ${r.role.replace(/_/g, " ").toLowerCase()}` }));
}
