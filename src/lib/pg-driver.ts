/**
 * Resolve node-postgres whatever the module interop shape turns out to be.
 *
 * Why this exists at all: `pg` is CommonJS, and under a native ESM loader
 * (`tsx`, `node --input-type=module`) the imported namespace exposes ONLY
 * `default` — so `const { Pool } = await import("pg")` destructures `undefined`
 * and the production database path dies at boot with "Pool is not a constructor".
 * That is exactly the kind of failure that never shows up while the tests run on
 * the embedded driver, so every place that opens a Postgres connection goes through
 * here and the resolution is asserted by a test.
 */
interface PgPoolLike {
  query: (...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  end: () => Promise<void>;
  /** pool events — teardown in tests listens for the idle-client error */
  on: (event: string, handler: (err: unknown) => void) => unknown;
}

type PoolCtor = new (config: Record<string, unknown>) => PgPoolLike;

export async function loadPg(): Promise<{ Pool: PoolCtor }> {
  const mod = (await import("pg")) as unknown as { Pool?: PoolCtor; default?: { Pool?: PoolCtor } };
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (typeof Pool !== "function") {
    throw new Error(
      "[db] node-postgres loaded but exposed no Pool constructor. " +
        "Check that `pg` is installed as a runtime dependency (not only a dev one).",
    );
  }
  return { Pool };
}
