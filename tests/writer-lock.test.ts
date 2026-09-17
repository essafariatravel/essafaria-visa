import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWriterLock, heldWriterLockPath } from "@/lib/pglite-writer-lock";

/* ============================================================
 * The embedded PGlite driver is in-process, so two processes on one data
 * directory corrupt each other (observed: the app's connection aborting
 * mid-request after a CLI job opened the same files). This lock is what turns
 * that silent corruption into an upfront, readable refusal.
 * ============================================================ */

let dir: string;
const LOCK = ".essafaria-writer.lock";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "esf-writer-"));
  delete process.env.ALLOW_PGLITE_MULTI_PROCESS;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.ALLOW_PGLITE_MULTI_PROCESS;
});

describe("pglite writer lock", () => {
  it("creates a lock naming the owner and releases it on exit", () => {
    const release = acquireWriterLock(dir, "unit-test");
    const payload = JSON.parse(fs.readFileSync(path.join(dir, LOCK), "utf8"));
    expect(payload.pid).toBe(process.pid);
    expect(payload.label).toBe("unit-test");
    expect(heldWriterLockPath()).toBe(path.join(dir, LOCK));
    release();
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(false);
  });

  it("refuses while another live process holds the directory", async () => {
    const other = spawn("sleep", ["5"], { stdio: "ignore" });
    await new Promise((r) => other.once("spawn", r));
    try {
      fs.writeFileSync(path.join(dir, LOCK), JSON.stringify({ pid: other.pid, label: "next dev" }), "utf8");
      let message = "";
      try {
        acquireWriterLock(dir, "unit-test");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("one writer at a time");
      expect(message).toContain(String(other.pid));
      expect(message).toContain("ALLOW_PGLITE_MULTI_PROCESS");
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("takes over a stale lock left by a crashed process", async () => {
    // a pid that is certainly gone: the killed child from the pattern above
    const dead = spawn("true", [], { stdio: "ignore" });
    await new Promise((r) => dead.once("exit", r));
    fs.writeFileSync(path.join(dir, LOCK), JSON.stringify({ pid: dead.pid, label: "ghost" }), "utf8");
    expect(() => acquireWriterLock(dir, "unit-test")).not.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(dir, LOCK), "utf8")).pid).toBe(process.pid);
  });

  it("does nothing for a directory that does not exist yet, and honours the escape hatch", () => {
    const missing = path.join(dir, "not-created");
    expect(() => acquireWriterLock(missing, "unit-test")).not.toThrow();
    expect(fs.existsSync(path.join(missing, LOCK))).toBe(false);

    process.env.ALLOW_PGLITE_MULTI_PROCESS = "1";
    fs.writeFileSync(path.join(dir, LOCK), JSON.stringify({ pid: 999_999, label: "other" }), "utf8");
    expect(() => acquireWriterLock(dir, "unit-test")).not.toThrow();
  });
});
