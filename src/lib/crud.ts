import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import type { ZodType } from "zod";
import { getDb, type Database } from "@/db";
import * as T from "@/db";
import {
  countryUpsertSchema,
  visaCategoryUpsertSchema,
  visaTypeUpsertSchema,
  requirementUpsertSchema,
  documentTypeUpsertSchema,
  statusUpsertSchema,
  priorityUpsertSchema,
  currencyUpsertSchema,
  feeUpsertSchema,
  templateUpsertSchema,
  brandingUpdateSchema,
  agencyUpsertSchema,
  navItemUpsertSchema,
} from "@/lib/validation";
import { invalidateConfig } from "@/lib/config-service";
import { logAudit, diff } from "@/lib/audit";
import { assertPermission, type Permission, type Role } from "@/lib/rbac";

/* ============================================================
 * Configuration service — the single write path for admin-editable
 * business configuration.
 *
 * Pipeline for every mutation:
 *   permission check → zod validation → upsert inside a
 *   transaction → audit row (atomic with the change) → cache
 *   invalidation.
 *
 * Referential safety (§23): destructive deletes are blocked at the
 * FK layer (ON DELETE RESTRICT); the UI offers deactivate/reactivate
 * instead. Renaming a record never touches its stable id, so future
 * application history keeps pointing at the right entity.
 * ============================================================ */

type AnyTable = any;

export interface Actor {
  id: string;
  email: string;
  role: Role;
}

export class ValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super("Validation failed: " + issues.join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class NotFoundError extends Error {
  constructor(what = "Record") {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export interface EntityDef {
  table: AnyTable;
  schema: ZodType;
  writePermission: Permission;
  auditType: string;
  orderable?: boolean;
  searchColumns?: AnyTable[];
  /** columns that may be omitted when editing but are mandatory when creating */
  requiredForCreate?: string[];
  /** extra zod parse step after schema.parse (e.g., cross-field checks) */
  transform?: (data: Record<string, unknown>) => Record<string, unknown>;
}

export type Entities =
  | "countries"
  | "visa-categories"
  | "visa-types"
  | "visa-requirements"
  | "document-types"
  | "statuses"
  | "priorities"
  | "currencies"
  | "fees"
  | "templates"
  | "branding"
  | "agencies"
  | "navigation";

export const ENTITIES: Record<Entities, EntityDef> = {
  countries: {
    table: T.countries,
    schema: countryUpsertSchema,
    writePermission: "countries.write",
    auditType: "country",
    orderable: true,
    searchColumns: [T.countries.name, T.countries.code],
  },
  "visa-categories": {
    table: T.visaCategories,
    schema: visaCategoryUpsertSchema,
    writePermission: "visa_categories.write",
    auditType: "visa_category",
    orderable: true,
    searchColumns: [T.visaCategories.name, T.visaCategories.code],
  },
  "visa-types": {
    table: T.visaTypes,
    schema: visaTypeUpsertSchema,
    writePermission: "visa_types.write",
    auditType: "visa_type",
    orderable: true,
    searchColumns: [T.visaTypes.name, T.visaTypes.code],
  },
  "visa-requirements": {
    table: T.visaRequirements,
    schema: requirementUpsertSchema,
    writePermission: "visa_requirements.write",
    auditType: "visa_requirement",
    orderable: true,
    // the visa type is a NOT NULL column; without this the "Add requirement"
    // form on the visa-type screen silently lost the field through validation
    requiredForCreate: ["visaTypeId"],
  },
  "document-types": {
    table: T.documentTypes,
    schema: documentTypeUpsertSchema,
    writePermission: "document_types.write",
    auditType: "document_type",
    orderable: true,
    searchColumns: [T.documentTypes.name, T.documentTypes.code],
  },
  statuses: {
    table: T.applicationStatuses,
    schema: statusUpsertSchema,
    writePermission: "statuses.write",
    auditType: "application_status",
    orderable: true,
    searchColumns: [T.applicationStatuses.label],
  },
  priorities: {
    table: T.priorities,
    schema: priorityUpsertSchema,
    writePermission: "priorities.write",
    auditType: "priority",
    orderable: true,
  },
  currencies: {
    table: T.currencies,
    schema: currencyUpsertSchema,
    writePermission: "currencies.write",
    auditType: "currency",
    searchColumns: [T.currencies.name],
  },
  fees: {
    table: T.visaFees,
    schema: feeUpsertSchema,
    writePermission: "pricing.write",
    auditType: "visa_fee",
  },
  templates: {
    table: T.communicationTemplates,
    schema: templateUpsertSchema,
    writePermission: "templates.write",
    auditType: "communication_template",
  },
  branding: {
    table: T.brandSettings,
    schema: brandingUpdateSchema,
    writePermission: "branding.write",
    auditType: "brand_settings",
  },
  agencies: {
    table: T.agencies,
    schema: agencyUpsertSchema,
    writePermission: "agencies.write",
    auditType: "agency",
    searchColumns: [T.agencies.name, T.agencies.code, T.agencies.city],
  },
  navigation: {
    table: T.navItems,
    schema: navItemUpsertSchema,
    writePermission: "navigation.write",
    auditType: "navigation_item",
    orderable: true,
    searchColumns: [T.navItems.label],
  },
};

export function entityDef(key: string): EntityDef {
  const def = (ENTITIES as Record<string, EntityDef | undefined>)[key];
  if (!def) throw new Error(`Unknown configuration entity: ${key}`);
  return def;
}

function parseOrThrow(def: EntityDef, raw: unknown): Record<string, unknown> {
  const res = def.schema.safeParse(raw);
  if (!res.success) {
    throw new ValidationError(
      res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const data = res.data as Record<string, unknown>;
  return def.transform ? def.transform(data) : data;
}

/* ---------------- reads ---------------- */

export async function listEntities(
  key: Entities,
  opts: { activeOnly?: boolean; q?: string; filters?: Record<string, string> } = {},
) {
  const def = entityDef(key);
  const db = await getDb();
  const t = def.table as any;
  let query: any = db.select().from(t);
  const where: unknown[] = [];
  if (opts.activeOnly && "isActive" in t) where.push(eq(t.isActive, true));
  if (opts.q && def.searchColumns?.length) {
    where.push(or(...def.searchColumns.map((c) => ilike(c as never, `%${opts.q}%`))));
  }
  for (const [col, val] of Object.entries(opts.filters ?? {})) {
    if (val) where.push(eq(t[col] as never, val));
  }
  if (where.length) query = query.where(and(...(where as never[])));
  if (def.orderable && "displayOrder" in t) {
    query = query.orderBy(asc(t.displayOrder), sql`${t.createdAt}`);
  } else {
    query = query.orderBy(sql`${t.createdAt}`);
  }
  return (await query.execute()) as Record<string, unknown>[];
}

export async function getEntityById(key: Entities, id: string) {
  const def = entityDef(key);
  const db = await getDb();
  const rows = await (db.select().from(def.table as any).where(eq((def.table as any).id, id)) as any).execute();
  return (rows[0] as Record<string, unknown>) ?? null;
}

/* ---------------- writes ---------------- */

export async function saveEntity(
  actor: Actor,
  key: Entities,
  raw: unknown,
  id?: string | null,
  contextAgencyId?: string | null,
): Promise<{ id: string }> {
  const def = entityDef(key);
  assertPermission(actor.role, def.writePermission);
  const data = parseOrThrow(def, raw);

  const db = await getDb();
  const t = def.table as any;

  // Branding is a singleton: the first row is the row.
  if (key === "branding" && !id) {
    const existing = (await db.select({ id: t.id }).from(t).limit(1).execute()) as { id: string }[];
    id = existing[0]?.id ?? null;
  }

  if (!id && def.requiredForCreate?.length) {
    const missing = def.requiredForCreate.filter((c) => data[c] === null || data[c] === undefined || data[c] === "");
    if (missing.length) throw new ValidationError(missing.map((c) => `${c}: required to create this ${def.auditType}`));
  }

  return db.transaction(async (tx: Database) => {
    const txn = tx as any;
    if (id) {
      const beforeRows = await txn.select().from(t).where(eq(t.id, id)).limit(1);
      const before = beforeRows[0] as Record<string, unknown> | undefined;
      if (!before) throw new NotFoundError();
      await txn
        .update(t)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(t.id, id));
      await logAudit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          action: "UPDATE",
          entityType: def.auditType,
          entityId: id,
          agencyId: contextAgencyId ?? null,
          changes: diff(before, data),
        },
        tx,
      );
      invalidateConfig();
      return { id };
    }
    const inserted = await txn.insert(t).values({ ...data }).returning({ id: t.id });
    const newId = inserted[0].id as string;
    await logAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: "CREATE",
        entityType: def.auditType,
        entityId: newId,
        agencyId: contextAgencyId ?? null,
        changes: { after: data },
      },
      tx,
    );
    invalidateConfig();
    return { id: newId };
  });
}

/** Soft delete — the safe alternative admins actually need. */
export async function setEntityActive(
  actor: Actor,
  key: Entities,
  id: string,
  active: boolean,
): Promise<void> {
  const def = entityDef(key);
  assertPermission(actor.role, def.writePermission);
  const db = await getDb();
  const t = def.table as any;
  if (!("isActive" in t)) throw new Error(`Entity ${key} has no active flag`);
  await db.transaction(async (tx: Database) => {
    const res = await (tx.update(t).set({ isActive: active, updatedAt: new Date() }).where(eq(t.id, id)) as any);
    void res;
    await logAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: active ? "REACTIVATE" : "DEACTIVATE",
        entityType: def.auditType,
        entityId: id,
      },
      tx,
    );
  });
  invalidateConfig();
}

/** Reorder by swapping with the neighbour in the same scope. */
export async function moveEntity(
  actor: Actor,
  key: Entities,
  id: string,
  direction: "up" | "down",
  scopeColumn?: string,
  scopeValue?: unknown,
): Promise<void> {
  const def = entityDef(key);
  if (!def.orderable) throw new Error(`Entity ${key} is not orderable`);
  assertPermission(actor.role, def.writePermission);
  const db = await getDb();
  const t = def.table as any;
  await db.transaction(async (tx: Database) => {
    const txn = tx as any;
    let query: any = txn.select().from(t);
    if (scopeColumn && scopeValue) query = query.where(eq(t[scopeColumn], scopeValue));
    const rows = (await query.orderBy(asc(t.displayOrder))) as Array<{ id: string; displayOrder: number }>;
    const idx = rows.findIndex((r) => r.id === id);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || swapWith < 0 || swapWith >= rows.length) return;
    const a = rows[idx]!;
    const b = rows[swapWith]!;
    await txn.update(t).set({ displayOrder: b.displayOrder }).where(eq(t.id, a.id));
    await txn.update(t).set({ displayOrder: a.displayOrder }).where(eq(t.id, b.id));
    await logAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: "REORDER",
        entityType: def.auditType,
        entityId: id,
        metadata: { direction },
      },
      tx,
    );
  });
  invalidateConfig();
}

/**
 * Hard delete — only for genuinely optional join/config rows (e.g. a
 * requirement link). Core entities are deactivated instead; FK RESTRICT
 * protects history (spec §23).
 */
export async function deleteEntity(actor: Actor, key: Entities, id: string): Promise<void> {
  const def = entityDef(key);
  assertPermission(actor.role, def.writePermission);
  const db = await getDb();
  const t = def.table as any;
  await db.transaction(async (tx: Database) => {
    await (tx.delete(t).where(eq(t.id, id)) as any);
    await logAudit(
      { actorId: actor.id, actorEmail: actor.email, action: "DELETE", entityType: def.auditType, entityId: id },
      tx,
    );
  });
  invalidateConfig();
}

export { assertPermission, invalidateConfig };
