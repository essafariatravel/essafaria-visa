import { z } from "zod";

/**
 * Validated environment access. Everything business-related lives in the
 * database / admin panel; this file is infrastructure only.
 *
 * DATABASE MODE RESOLUTION (production is the canonical target):
 *   1. If DATABASE_URL is set            → "postgres"  (managed Postgres)
 *   2. Else if DATABASE_MODE=pglite      → embedded PGlite (sandbox/dev/tests only)
 *   3. Else                              → hard error, no silent surprises
 */
const schema = z.object({
  DATABASE_URL: z.string().url().optional(),
  DATABASE_MODE: z.enum(["pglite", "postgres"]).optional(),
  PGLITE_DATA_DIR: z.string().default(".data/pgdata"),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_AGENCY_PASSWORD: z.string().min(8).optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  MEDIA_ROOT: z.string().default(".data/uploads"),
  MEDIA_PROVIDER: z.enum(["local", "supabase"]).default("local"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default("essafaria-media"),

  /* ---- outbound email (Phase 7) ----
   * Declared explicitly because this schema is the ONLY window the app has onto
   * process.env: an undeclared variable is stripped, and an operator could set
   * EMAIL_TRANSPORT=file forever while the code quietly kept reading "none". */
  EMAIL_TRANSPORT: z.enum(["none", "file", "log", "smtp"]).optional(),
  SMTP_URL: z.string().min(1).optional(),
  SENDGRID_API_KEY: z.string().min(1).optional(),

  /* ---- AI provider (Phase 9) — reference names, never the secret itself ---- */
  AI_PROVIDER: z.enum(["none", "rules", "openai", "anthropic", "gemini", "ollama"]).default("none"),
  AI_MODEL: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY_REF: z.string().min(1).optional(), // NAME of the env var holding the key
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8000).default(900),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),

  /* ---- Gmail intake (Phase 8) — same rule: reference names only ---- */
  GMAIL_ENABLED: z.enum(["true", "false"]).optional(),
  GMAIL_PROVIDER: z.enum(["none", "google", "fixture"]).optional(),
  GMAIL_CLIENT_ID_REF: z.string().min(1).optional(),
  GMAIL_CLIENT_SECRET_REF: z.string().min(1).optional(),
  GMAIL_REDIRECT_URI: z.string().url().optional(),
  GMAIL_TOKEN_KEY_REF: z.string().min(1).optional(), // NAME of the env var with the AES key
  GMAIL_POLL_QUERY: z.string().min(1).optional(),

  /* ---- rate limiting / security (Phase 10) ---- */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(8),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(5).max(10000).default(240),
  REQUIRE_HTTPS: z.enum(["true", "false"]).optional(),
  /** Set to "false" when no trusted proxy fronts this process (see src/lib/same-site.ts). */
  TRUST_PROXY_HEADERS: z.enum(["true", "false"]).optional(),
});

export type AppEnv = z.infer<typeof schema> & { dbMode: "pglite" | "postgres" };

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  // Vercel/Supabase integrations may expose POSTGRES_URL (or one of the
  // related aliases) instead of the app-specific DATABASE_URL. Normalize those
  // names here so the application has one canonical database setting.
  const runtimeEnv = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URL ??
      process.env.POSTGRES_PRISMA_URL ??
      process.env.POSTGRES_URL_NON_POOLING,
    APP_URL:
      process.env.APP_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : undefined),
    MEDIA_PROVIDER: process.env.MEDIA_PROVIDER ?? (process.env.VERCEL ? "supabase" : "local"),
  };
  const parsed = schema.safeParse(runtimeEnv);
  if (!parsed.success) {
    throw new Error(
      "Invalid environment configuration:\n" +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n"),
    );
  }
  const raw = parsed.data;
  const dbMode: "pglite" | "postgres" =
    raw.DATABASE_MODE ?? (raw.DATABASE_URL ? "postgres" : "pglite");
  if (dbMode === "postgres" && !raw.DATABASE_URL) {
    throw new Error("DATABASE_MODE=postgres requires DATABASE_URL");
  }
  cached = { ...raw, dbMode };
  return cached;
}

/** Test-only helper: reset the memoized env between vitest cases. */
export function __resetEnvCacheForTests(): void {
  cached = null;
}
