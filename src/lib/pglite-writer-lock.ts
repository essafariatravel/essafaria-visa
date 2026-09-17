import fs from "node:fs";
import path from "node:path";

/* ============================================================
 * Single-writer lock for the embedded PGlite data directory.
 *
 * WHY
 * PGlite is PostgreSQL running *inside the process*, driven from a directory on
 * disk. It is not a server: a second process opening the same directory does not
 * get a polite refusal — it tears the first one's cluster down. Observed in this
 * repo: running `npm run outbox:drain` while the app was serving made every later
 * request fail with `Aborted()` from the WASM engine and the whole UI went 500.
 *
 * Real Postgres has no such limit, which is why this guard is deliberately narrow:
 * it exists only for the embedded dev/sandbox driver, never for DATABASE_URL.
 *
 * HOW
 * A lock file beside the cluster records the owning pid. A lock whose pid is gone
 * is stale and is taken over (a crashed dev server must not wedge the repo). A live
 * pid is a genuine second writer and the caller gets an actionable error instead of
 * corruption. Release happens on process exit; there are no signal handlers here on
 * purpose, so nothing interferes with how the supervisor stops the app.
 * ============================================================ */

const LOCK_NAME = ".essafaria-writer.lock";
const ENV_OVERRIDE = "ALLOW_PGLITE_MULTI_PROCESS";

let held: { path: string; pid: number } | null = null;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claim the data directory for this process. Returns a release function; the caller
 * normally ignores it because release is also wired to process exit.
 * Throws when another live process holds the directory.
 */
export function acquireWriterLock(dataDir: string, label: string): () => void {
  if (process.env[ENV_OVERRIDE] === "1") return () => {};
  if (!fs.existsSync(dataDir)) return () => {}; // nothing to protect yet (fresh clone)

  const lockPath = path.join(dataDir, LOCK_NAME);
  if (held?.path === lockPath) return () => {}; // same process, second call

  let existing: { pid?: number; label?: string; startedAt?: string } | null = null;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    existing = null;
  }
  if (existing?.pid && pidAlive(existing.pid) && existing.pid !== process.pid) {
    throw new Error(
      `[db] ${label} cannot open ${dataDir}: process ${existing.pid}` +
        ` (${existing.label ?? "unknown"}) already holds this embedded database.\n` +
        `       PGlite is in-process — one writer at a time. Stop the other process first\n` +
        `       (e.g. the dev/prod server), or point both at real PostgreSQL with DATABASE_URL.\n` +
        `       Only if you are certain the other process will not touch the files:\n` +
        `       ${ENV_OVERRIDE}=1 <command>`,
    );
  }

  const payload = JSON.stringify({ pid: process.pid, label, startedAt: new Date().toISOString() }, null, 0);
  fs.writeFileSync(lockPath, payload, "utf8");
  held = { path: lockPath, pid: process.pid };

  const release = () => {
    if (!held || held.path !== lockPath || held.pid !== process.pid) return;
    try {
      const now = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (now?.pid === process.pid) fs.unlinkSync(lockPath);
    } catch {
      /* already gone — nothing to clean */
    }
    held = null;
  };
  process.on("exit", release);
  return release;
}

/** Test/inspection seam: is this process holding a directory? */
export function heldWriterLockPath(): string | null {
  return held?.path ?? null;
}
