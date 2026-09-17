import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "@/lib/env";

/* ============================================================
 * Outbound email transport (Phase 7).
 *
 * The platform never fakes delivery. Three modes:
 *
 *   none  (default) — nothing is sent. Outbox rows are recorded as SKIPPED
 *                     with reason NO_TRANSPORT at creation time, so an operator
 *                     can see "not sent, by configuration" rather than a queue
 *                     that quietly grows forever.
 *   file            — a real, verifiable local transport: each message is
 *                     written as an .eml file under MEDIA_ROOT/outbox and
 *                     reported SENT with a providerMessageId derived from the
 *                     file. Used by dev, tests and this sandbox, where there is
 *                     no SMTP relay. Behaviour is exercised end-to-end; it is
 *                     simply not delivery to the internet.
 *   smtp            — the interface a production deployment uses. Requires an
 *                     SMTP client dependency and credentials; until those are
 *                     present this adapter fails LOUDLY (never silently
 *                     "succeeds"), so a misconfiguration cannot masquerade as
 *                     delivered mail.
 *
 * Adding a real provider (SES/Postmark/SMTP) means implementing send() here —
 * no call site in the application changes.
 * ============================================================ */

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  replyTo?: string | null;
  fromName?: string | null;
}

export interface EmailTransport {
  name: "none" | "file" | "smtp";
  configured: boolean;
  send(email: OutboundEmail): Promise<{ ok: boolean; providerMessageId?: string; error?: string }>;
}

export type EmailTransportName = "none" | "file" | "smtp";

export function resolveTransportName(): EmailTransportName {
  const e = env() as unknown as Record<string, unknown>;
  const raw = String(e["EMAIL_TRANSPORT"] ?? "").toLowerCase();
  if (raw === "file" || raw === "log") return "file";
  if (raw === "smtp") return "smtp";
  if (raw === "none") return "none";
  if (e["SMTP_URL"] || e["SENDGRID_API_KEY"]) return "smtp";
  return "none";
}

/** True when a send attempt can actually leave the building (or the disk). */
export function emailTransportAvailable(): boolean {
  return resolveTransportName() !== "none";
}

let cached: EmailTransport | null = null;

export function getEmailTransport(): EmailTransport {
  if (cached) return cached;
  const name = resolveTransportName();
  if (name === "file") {
    const dir = path.resolve(process.cwd(), env().MEDIA_ROOT, "outbox");
    cached = {
      name: "file",
      configured: true,
      async send(email) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const id = crypto.randomBytes(6).toString("hex");
        const file = path.join(dir, `${stamp}-${id}.eml`);
        const fromName = email.fromName ?? "ESSAFARIA Travel";
        const raw = [
          `To: ${email.to}`,
          `From: ${fromName} <no-reply@essafaria.local>`,
          email.replyTo ? `Reply-To: ${email.replyTo}` : "",
          `Subject: ${email.subject}`,
          `Date: ${new Date().toUTCString()}`,
          `Message-Id: <${id}.${Date.now()}@essafaria.local>`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          email.body,
          "",
        ]
          .filter(Boolean)
          .join("\r\n");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, raw, "utf8");
        return { ok: true, providerMessageId: `file:${path.basename(file)}` };
      },
    };
    return cached;
  }
  if (name === "smtp") {
    cached = {
      name: "smtp",
      configured: false,
      async send() {
        // Deliberate, honest failure: no SMTP client dependency is bundled and
        // no credentials exist in this environment. A provider adapter must
        // fail rather than pretend.
        return {
          ok: false,
          error:
            "SMTP transport selected but no provider client is installed in this build — add a dependency (e.g. nodemailer) and credentials, or set EMAIL_TRANSPORT=file",
        };
      },
    };
    return cached;
  }
  const none: EmailTransport = {
    name: "none",
    configured: false,
    async send() {
      return { ok: false, error: "NO_TRANSPORT" };
    },
  };
  cached = none;
  return cached;
}

/** Test seam: swap the memoized transport (dev/tests only). */
export function __setEmailTransportForTests(t: EmailTransport | null): void {
  cached = t;
}
