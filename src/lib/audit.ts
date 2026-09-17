import { getDb, auditLogs, type Database } from "@/db";

/* ============================================================
 * Audit logging — every sensitive mutation records who changed
 * what. Callers pass the in-flight transaction so the audit row
 * commits atomically with the change it describes.
 * ============================================================ */

import type { AuditActionName } from "@/db/schema";

/** The audit vocabulary is the DB enum — one definition, no drift between
 *  schema and code. */
export type AuditAction = AuditActionName;

export type { AuditActionName };

export interface AuditInput {
  actorId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  agencyId?: string | null;
  changes?: { before?: unknown; after?: unknown };
  metadata?: Record<string, unknown>;
}

export async function logAudit(input: AuditInput, tx?: Database): Promise<void> {
  const db = tx ?? (await getDb());
  await db.insert(auditLogs).values({
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agencyId: input.agencyId ?? null,
    changes: input.changes ?? null,
    metadata: input.metadata ?? null,
  });
}

/** Shallow field diff — keeps audit rows small and readable. */
export function diff<T extends Record<string, unknown>>(
  before: T | undefined,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changed = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const [k, v] of Object.entries(after)) {
    if (!before || JSON.stringify(before[k]) !== JSON.stringify(v)) {
      changed.before[k] = before?.[k] ?? null;
      changed.after[k] = v;
    }
  }
  return changed;
}
