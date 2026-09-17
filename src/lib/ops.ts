import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  applicationReferenceCounters,
  applicationStatuses,
  type Database,
  type VisaApplication,
} from "@/db";
import { logAudit, type AuditActionName } from "@/lib/audit";
import { can as roleCan } from "@/lib/rbac";
import { invalidateConfig } from "@/lib/config-service";

/* ============================================================
 * Operational core — shared primitives every operational service
 * (applications, documents, billing, notifications, automation)
 * builds on. Keeping them here means ONE implementation of the
 * invariants the whole platform depends on:
 *
 *   1. money = integer minor units (bigint), rounding is explicit
 *   2. references are minted under a row lock, so two concurrent
 *      requests can never receive the same number
 *   3. every state change writes its audit row INSIDE the same
 *      transaction as the change itself
 *   4. configuration is read by stable id and denormalized into the
 *      row that uses it, so later renames cannot rewrite history
 * ============================================================ */

/** Both drivers (node-postgres, PGlite) expose the same query surface here.
 *  Services use `any` at the query edge exactly like the foundation's CRUD
 *  layer, so one code path serves both. */
type Q = any;

/* ---------------- money ---------------- */

/** INT8 headroom; anything beyond this is rejected rather than wrapped. */
export const MAX_MONEY_CENTS = 9_000_000_000_000; // 9e12 cents

/** Round-half-up on integer cents. Never use floats to compute money. */
export function roundCents(value: number): number {
  if (!Number.isFinite(value)) throw new DomainError("VALIDATION", "money: non-finite amount");
  return Math.round(value);
}

export function assertCents(value: unknown, field = "amount"): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DomainError("VALIDATION", `${field} must be a whole number of cents`);
  }
  if (Math.abs(value) > MAX_MONEY_CENTS) {
    throw new DomainError("VALIDATION", `${field} exceeds the supported range`);
  }
  return value;
}

/** Percentage is an integer percent of the base, applied once, rounded UP so a
 *  surcharge is never silently lost to truncation. Pure integer arithmetic. */
export function applySurcharge(baseCents: number, percent: number): number {
  if (!Number.isInteger(baseCents) || !Number.isInteger(percent)) {
    throw new DomainError("VALIDATION", "surcharge inputs must be integers");
  }
  if (baseCents < 0 || percent < 0 || percent > 500) {
    throw new DomainError("VALIDATION", "surcharge inputs out of range");
  }
  if (percent === 0) return baseCents;
  return Math.floor((baseCents * (100 + percent) + 99) / 100); // ceil division
}

/* ---------------- errors ---------------- */

export type DomainErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "TENANT_MISMATCH"
  | "STATE_CONFLICT"
  | "RACE"
  | "INSUFFICIENT_FUNDS"
  | "DUPLICATE"
  | "CONFIG"
  | "GATE_FAILED";

/** One error type for the whole operational layer: machine code + a human-safe
 *  message + optional field issues. HTTP/UI layers map from the code, so no
 *  stack traces, SQL text or driver errors leak upward. */
export class DomainError extends Error {
  code: DomainErrorCode;
  issues?: string[];
  constructor(code: DomainErrorCode, message: string, issues?: string[]) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.issues = issues;
  }
}

export const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  // cross-tenant probes must not become existence oracles
  TENANT_MISMATCH: 404,
  STATE_CONFLICT: 409,
  RACE: 409,
  INSUFFICIENT_FUNDS: 402,
  DUPLICATE: 409,
  CONFIG: 500,
  GATE_FAILED: 409,
};

export function describeDomainError(err: unknown): {
  status: number;
  message: string;
  issues?: string[];
} {
  if (err instanceof DomainError) {
    return { status: STATUS_BY_CODE[err.code], message: err.message, issues: err.issues };
  }
  const name = (err as { name?: string })?.name;
  if (name === "ValidationError" && Array.isArray((err as { issues?: string[] }).issues)) {
    const e = err as { issues: string[] };
    return { status: 422, message: "Validation failed", issues: e.issues };
  }
  if (name === "AuthorizationError") {
    const m = (err as Error).message;
    return { status: m === "Authentication required" ? 401 : 403, message: m };
  }
  if (name === "TenantError") return { status: 404, message: "Not found" };
  const msg = err instanceof Error ? err.message : String(err);
  if (/duplicate key|violates unique constraint/i.test(msg)) {
    return { status: 409, message: "Duplicate value — this reference/code already exists." };
  }
  if (/violates foreign key constraint/i.test(msg)) {
    return { status: 409, message: "This record is referenced by other data — deactivate it instead." };
  }
  console.error("[ops] unhandled error:", err);
  return { status: 500, message: "Internal error" };
}

/* ---------------- capability enforcement ---------------- */

/**
 * Capability check INSIDE the service layer.
 *
 * Routes and server actions check permissions too, but that must never be the
 * only gate: a service can also be reached by automation, an integration, or a
 * hand-built request. "The route already checked" is not an invariant — so each
 * operational entry point asserts its own capability and throws a DomainError,
 * which the HTTP layer maps to 403 and every other caller sees as a rejection.
 */
export function assertActorPermission(actor: { role: string } | null | undefined, permission: string): void {
  if (!actor) throw new DomainError("FORBIDDEN", "Authentication required");
  if (!roleCan(actor.role as never, permission as never)) {
    throw new DomainError("FORBIDDEN", "Your role may not perform this operation");
  }
}

/* ---------------- driver helpers ---------------- */

/** Normalized "rows affected" across both drivers: node-postgres reports
 *  `rowCount`, PGlite reports `affectedRows`. Conditional UPDATEs use this to
 *  detect a lost race without parsing driver-specific result shapes. */
export function affectedRows(result: unknown): number {
  const r = result as { rowCount?: number | null; affectedRows?: number | null } | undefined;
  const n = r?.rowCount ?? r?.affectedRows ?? 0;
  return typeof n === "number" ? n : 0;
}

export function db(): Promise<Database> {
  return getDb();
}

/* ---------------- unique reference minting ---------------- */

/**
 * Mint a per-period sequence value atomically.
 *
 * The counter row is locked with SELECT … FOR UPDATE before it is
 * incremented, so two concurrent submissions cannot read the same number; the
 * conditional `WHERE last_number = current` update turns any remaining race
 * into a detected RACE instead of a duplicate reference. A unique index on the
 * generated reference is the third line of defence.
 *
 * VERIFICATION: SQL correctness + transactional ordering are verified against
 * embedded PostgreSQL (PGlite). Multi-connection contention requires a real
 * Postgres server — see the concurrency notes in the delivery report.
 */
export async function nextSequence(period: string, tx: Database): Promise<number> {
  const t: Q = tx;
  await t.insert(applicationReferenceCounters).values({ period, lastNumber: 0 }).onConflictDoNothing();
  const locked = await t.execute(
    sql`select last_number from application_reference_counters where period = ${period} for update`,
  );
  const rows = (locked?.rows ?? locked ?? []) as Array<{ last_number: number | string }>;
  if (!rows.length) throw new DomainError("CONFIG", "reference counter row missing after upsert");
  const current = Number(rows[0]!.last_number);
  const next = current + 1;
  const upd = await t.execute(
    sql`update application_reference_counters
           set last_number = ${next}, updated_at = now()
         where period = ${period} and last_number = ${current}`,
  );
  if (affectedRows(upd) !== 1) {
    throw new DomainError("RACE", "Reference counter changed mid-transaction — retry the request.");
  }
  return next;
}

/** ESF-2026-000123 */
export function formatApplicationReference(period: string, n: number): string {
  return `ESF-${period}-${String(n).padStart(6, "0")}`;
}

/** INV-2026-000123 */
export function formatInvoiceReference(period: string, n: number): string {
  return `INV-${period}-${String(n).padStart(6, "0")}`;
}

/* ---------------- configuration denormalization ---------------- */

export interface FrozenStatus {
  id: string;
  code: string;
  label: string;
  isTerminal: boolean;
  requiresDocumentsComplete: boolean;
  customerVisible: boolean;
  allowedNextStatusCodes: string[] | null;
  color: string | null;
}

function freeze(row: typeof applicationStatuses.$inferSelect): FrozenStatus {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    isTerminal: row.isTerminal,
    requiresDocumentsComplete: row.requiresDocumentsComplete,
    customerVisible: row.customerVisible,
    allowedNextStatusCodes: Array.isArray(row.allowedNextStatusCodes) ? row.allowedNextStatusCodes : null,
    color: row.color,
  };
}

/** Read a status by id — the only way status semantics enter logic. */
export async function loadStatusById(statusId: string, tx?: Database): Promise<FrozenStatus> {
  const t: Q = tx ?? (await getDb());
  const rows = (await t
    .select()
    .from(applicationStatuses)
    .where(eq(applicationStatuses.id, statusId))
    .limit(1)) as Array<typeof applicationStatuses.$inferSelect>;
  const row = rows[0];
  if (!row) throw new DomainError("CONFIG", "Workflow status is missing from configuration");
  return freeze(row);
}

/** Read a status by configured code (codes are the stable admin-facing handle). */
export async function loadStatusCode(code: string, tx?: Database): Promise<FrozenStatus | null> {
  const t: Q = tx ?? (await getDb());
  const rows = (await t
    .select()
    .from(applicationStatuses)
    .where(eq(applicationStatuses.code, code))
    .limit(1)) as Array<typeof applicationStatuses.$inferSelect>;
  return rows[0] ? freeze(rows[0]) : null;
}

/** Resolve several codes to configuration rows in one query. */
export async function resolveStatusCodes(
  codes: string[],
  tx?: Database,
): Promise<Map<string, FrozenStatus>> {
  const t: Q = tx ?? (await getDb());
  const rows = (await t
    .select()
    .from(applicationStatuses)
    .where(inArray(applicationStatuses.code, codes))) as Array<typeof applicationStatuses.$inferSelect>;
  return new Map(rows.map((r) => [r.code, freeze(r)]));
}

/** The configured first status for a new file (code NEW; falls back to the
 *  first active non-terminal status so a fresh install still works). */
export async function resolveInitialStatus(tx?: Database): Promise<FrozenStatus> {
  const preferred = await loadStatusCode("NEW", tx);
  if (preferred) return preferred;
  const t: Q = tx ?? (await getDb());
  const rows = (await t
    .select()
    .from(applicationStatuses)
    .where(and(eq(applicationStatuses.isActive, true), eq(applicationStatuses.isTerminal, false)))
    .limit(1)) as Array<typeof applicationStatuses.$inferSelect>;
  const first = rows[0];
  if (!first) {
    throw new DomainError("CONFIG", "No active non-terminal application status is configured");
  }
  return freeze(first);
}

/** Is the application currently in a terminal state? Drives every
 *  "immutable after closure" rule — read from configuration, not from code. */
export async function isTerminalStatus(statusId: string, tx?: Database): Promise<boolean> {
  return (await loadStatusById(statusId, tx)).isTerminal;
}

/* ---------------- audit (transaction-bound) ---------------- */

export interface Actor {
  id: string;
  email: string;
  role: string;
}

export async function auditIn(
  tx: Database,
  input: {
    actor: Actor | null;
    action: AuditActionName;
    entityType: string;
    entityId: string;
    agencyId?: string | null;
    changes?: { before?: unknown; after?: unknown };
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await logAudit(
    {
      actorId: input.actor?.id ?? null,
      actorEmail: input.actor?.email ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agencyId: input.agencyId ?? null,
      changes: input.changes,
      metadata: input.metadata,
    },
    tx as unknown as Database,
  );
}

/** Configuration writes invalidate the config cache immediately, including
 *  mutations made through the operational services rather than the CRUD layer. */
export function touchConfigCache(): void {
  invalidateConfig();
}

/** Guard used by every agency-facing read/write that takes an id. Returns the
 *  same NOT_FOUND shape as a genuinely missing row: no existence oracle. */
export function assertApplicationTenant(app: VisaApplication | null, agencyId: string | null): VisaApplication {
  if (!app) throw new DomainError("NOT_FOUND", "Application not found");
  if (!agencyId || app.agencyId !== agencyId) {
    throw new DomainError("NOT_FOUND", "Application not found");
  }
  return app;
}

/* ---------------- idempotent append helper ---------------- */

/**
 * Insert-or-ignore, returning the winning row's id.
 *
 * `ON CONFLICT DO NOTHING` without a target is used deliberately: the
 * idempotency arbiters here are PARTIAL unique indexes (e.g. "WHERE key IS NOT
 * NULL"), and a targeted `ON CONFLICT (col)` would not infer them — Postgres
 * would raise 42P10 instead of skipping. When the insert is skipped, the
 * caller's `lookup` predicate fetches the row that already won, so a retried
 * request reuses the original effect instead of creating a second one.
 */
export async function insertIgnoreReturningId(
  tx: Database,
  table: unknown,
  values: Record<string, unknown>,
  lookup?: Array<{ column: unknown; value: unknown }>,
): Promise<{ id: string; inserted: boolean }> {
  const t: Q = tx;
  const res = await t.insert(table).values(values).onConflictDoNothing().returning({ id: (table as Q).id });
  if (res?.length) return { id: res[0].id as string, inserted: true };
  if (!lookup?.length) throw new DomainError("RACE", "Insert was skipped but no lookup was provided to find the winner");
  const conds = lookup
    .filter((l) => l.value !== undefined && l.value !== null)
    .map((l) => eq(l.column as never, l.value as never));
  const existing = (conds.length
    ? await t.select({ id: (table as Q).id }).from(table).where(and(...conds))
    : await t.select({ id: (table as Q).id }).from(table)) as Array<{ id: string }>;
  if (!existing[0]) {
    throw new DomainError("RACE", "Idempotent insert raced and the winner is not yet visible — retry.");
  }
  return { id: existing[0].id, inserted: false };
}

export type { VisaApplication };
