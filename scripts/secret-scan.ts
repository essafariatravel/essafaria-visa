import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Secret scan — refuses anything that must never be committed:
 * .env files (beyond .env.example), private keys, live-looking tokens.
 * Scope = exactly what git would commit (tracked + untracked, minus
 * gitignored), so local dev .env files are correctly out of scope while
 * still being verified as ignored by .gitignore itself.
 */
const IGNORE_SELF = "scripts/secret-scan.ts";
const PATTERNS: Array<[string, RegExp]> = [
  ["private key block", /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["aws access key", /AKIA[0-9A-Z]{16}/],
  ["github token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["slack token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["generic long secret assignment", /(?:password|secret|token|api_?key)["']?\s*[:=]\s*["'][^"'\n]{16,}["']/i],
  ["postgres url with embedded password", /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]{8,}@/],
];

/**
 * A deployment file is allowed to *reference* a credential without carrying one, and
 * that is the pattern we ask for (compose `${POSTGRES_PASSWORD}`, workflow
 * `${{ secrets.X }}`). This recognises only those two shapes: if what remains where the
 * secret was is empty, the line points at a secret store instead of containing one.
 * Anything literal — a password, a token, a URL with an embedded credential — is still a
 * violation, and every other rule is checked literally, with no exception at all.
 */
function isReferenceOnly(rule: string, text: string): boolean {
  const strip = (t: string) =>
    t
      .replace(/\$\{\{[^}]*\}\}/g, "") // GitHub Actions: ${{ secrets.X }}
      .replace(/\$\{[^}]*\}/g, "") // compose / shell: ${VAR:-default}
      .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "") // $VAR
      .trim();
  if (rule === "postgres url with embedded password") {
    // remove the references first, then ask whether a credential is still embedded.
    // Splitting on ":" instead would be fooled by `${VAR:-default}`, whose own colon is
    // not the user/password separator.
    return !/\/\/[^@\s]*:[^\s@]{1,}@/.test(strip(text));
  }
  if (rule === "generic long secret assignment") {
    const val = /[:=]\s*["']([^"']*)["']/.exec(text)?.[1] ?? "";
    return strip(val).length === 0;
  }
  return false;
}

const files = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" })
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

let violations = 0;

for (const rel of files) {
  const base = path.basename(rel);
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) {
    console.error(`[secret-scan] FAIL committed env file: ${rel}`);
    violations++;
    continue;
  }
  if (rel === IGNORE_SELF) continue;
  const abs = path.resolve(process.cwd(), rel);
  if (!fs.existsSync(abs)) continue;
  const stat = fs.statSync(abs);
  if (stat.size > 2_000_000) continue;
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    continue; // binary
  }
  for (const [name, re] of PATTERNS) {
    const m = content.match(re);
    if (m && !isReferenceOnly(name, m[0])) {
      console.error(`[secret-scan] FAIL ${rel}: ${name} → ${m[0].slice(0, 40)}…`);
      violations++;
    }
  }
}

// belt & braces: verify the local .env is actually git-ignored
try {
  execSync("git check-ignore -q .env", { stdio: "pipe" });
} catch {
  if (fs.existsSync(path.resolve(process.cwd(), ".env"))) {
    console.error("[secret-scan] FAIL: local .env exists but is NOT git-ignored");
    violations++;
  }
}

if (violations > 0) {
  console.error(`[secret-scan] ${violations} violation(s)`);
  process.exit(1);
}
console.log(`[secret-scan] ok — scanned ${files.length} committable files, no secrets found`);
