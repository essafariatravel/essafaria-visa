import { AsyncLocalStorage } from "node:async_hooks";
import { getDb, type Database } from "@/db";
import { DomainError } from "@/lib/ops";

/* ============================================================
 * Transaction entry point for every operational service.
 *
 * WHY THIS EXISTS: the single most dangerous bug class in a service layer like
 * this is a helper that resolves its OWN database handle while an outer
 * transaction is already open. On PostgreSQL that silently reads — and can
 * write — OUTSIDE the atomic unit (torn money moves, audit rows that commit
 * without their change); on the embedded single-connection driver it deadlocks
 * outright, which is how this guard got written.
 *
 * `withTx` therefore
 *   1. opens exactly ONE transaction per public operation, and
 *   2. refuses to nest, tracked per async context with AsyncLocalStorage so
 *      concurrent requests do not block each other (a module-level boolean
 *      would false-positive the moment two submissions race).
 *
 * Services must pass the `tx` handle down to every helper they call — which is
 * also why every helper takes an optional handle rather than importing the
 * connection itself.
 * ============================================================ */

const store = new AsyncLocalStorage<{ inTransaction: boolean }>();

/** True while the current async context holds an open transaction. */
export function isInTransaction(): boolean {
  return store.getStore()?.inTransaction === true;
}

export async function withTx<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
  if (isInTransaction()) {
    throw new DomainError(
      "CONFIG",
      "Nested transaction attempted — pass the active transaction handle to the helper instead",
    );
  }
  const db = (await getDb()) as unknown as {
    transaction: (cb: (tx: Database) => Promise<T>) => Promise<T>;
  };
  return store.run({ inTransaction: true }, async () => db.transaction((tx) => fn(tx)));
}
