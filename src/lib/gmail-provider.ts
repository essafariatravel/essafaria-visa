import crypto from "node:crypto";
import { env } from "@/lib/env";
import { DomainError } from "@/lib/ops";

/* ============================================================
 * Gmail provider abstraction (Phase 8).
 *
 * Two implementations behind one interface:
 *
 *   google  — the real REST integration (OAuth 2.0 code + PKCE, messages.list,
 *             messages.get, attachments.get, drafts.create). Written to the API
 *             contract, with timeouts and error mapping.
 *   fixture — deterministic local/dev/test mailbox, so the whole intake
 *             pipeline (ingest → classify → match → stage → link) is exercised
 *             for real in this environment.
 *
 * VERIFICATION NOTE: the fixture path is fully tested. The `google` adapter is
 * NOT verified against live Gmail here — this sandbox has no credentials and no
 * outbound access to googleapis.com. Anything built on it is reported as
 * "architecture implemented, live integration not verified", never as tested.
 *
 * Sending is deliberately absent. The platform may create a DRAFT in the
 * mailbox; a human presses send. That is a product rule, not a missing feature.
 * ============================================================ */

export interface RawAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface RawGmailMessage {
  id: string;
  threadId: string | null;
  from: string | null;
  to: string[];
  subject: string | null;
  snippet: string | null;
  bodyText: string;
  bodyHtml: string | null;
  labels: string[];
  receivedAt: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: RawAttachment[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scope: string | null;
  email: string | null;
}

export interface GmailProvider {
  readonly name: "google" | "fixture";
  authorizeUrl(input: { clientId: string; redirectUri: string; state: string; codeVerifier: string }): string;
  exchangeCode(input: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }): Promise<OAuthTokens>;
  refresh(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<OAuthTokens>;
  list(input: { accessToken: string; query: string; maxResults: number; pageToken?: string | null }): Promise<{ messages: RawGmailMessage[]; nextPageToken: string | null; historyId: string | null }>;
  get(input: { accessToken: string; id: string }): Promise<RawGmailMessage | null>;
  getAttachment(input: { accessToken: string; messageId: string; attachmentId: string }): Promise<{ bytes: Buffer; mimeType: string } | null>;
  createDraft(input: { accessToken: string; threadId: string | null; to: string; subject: string; body: string; inReplyTo: string | null }): Promise<{ draftId: string; messageId: string | null }>;
}

/* ---------------- Google (real) ---------------- */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"].join(" ");

function decodeBase64Url(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function header(headers: Array<{ name: string; value: string }>, name: string): string | null {
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 20_000): Promise<{ ok: boolean; status: number; data: any; errorText: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, data, errorText: res.ok ? "" : String(data?.error?.message ?? data?.error_description ?? res.statusText).slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, data: null, errorText: (err as Error).name === "AbortError" ? "timeout" : String((err as Error).message).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

function flattenParts(parts: GmailPart[] | undefined, into: GmailPart[] = []): GmailPart[] {
  for (const p of parts ?? []) {
    into.push(p);
    if (p.parts?.length) flattenParts(p.parts, into);
  }
  return into;
}

function interpret(raw: { id: string; threadId?: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart }): RawGmailMessage {
  const payload = raw.payload ?? {};
  const headers = payload.headers ?? [];
  const leafs = flattenParts(payload.parts?.length ? payload.parts : [payload]);
  const textPart = leafs.find((p) => p.mimeType === "text/plain" && p.body?.data);
  const htmlPart = leafs.find((p) => p.mimeType === "text/html" && p.body?.data);
  const attachments = leafs
    .filter((p) => p.filename && p.body?.attachmentId)
    .map((p) => ({
      attachmentId: p.body!.attachmentId!,
      filename: String(p.filename).slice(0, 200),
      mimeType: String(p.mimeType ?? "application/octet-stream").slice(0, 120),
      sizeBytes: Number(p.body?.size ?? 0),
    }));
  const refs = (header(headers, "References") ?? "").split(/\s+/).filter(Boolean);
  const dateValue = header(headers, "Date");
  const parsedDate = dateValue ? new Date(dateValue) : null;
  return {
    id: raw.id,
    threadId: raw.threadId ?? null,
    from: header(headers, "From"),
    to: (header(headers, "To") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    subject: header(headers, "Subject"),
    snippet: raw.snippet ?? null,
    bodyText: decodeBase64Url(textPart?.body?.data ?? (payload.mimeType === "text/plain" ? payload.body?.data : undefined)) || decodeBase64Url(raw.snippet),
    bodyHtml: htmlPart?.body?.data ? decodeBase64Url(htmlPart.body.data) : null,
    labels: raw.labelIds ?? [],
    receivedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : raw.internalDate ? new Date(Number(raw.internalDate)).toISOString() : null,
    inReplyTo: header(headers, "In-Reply-To"),
    references: refs.slice(0, 20),
    attachments,
  };
}

const googleProvider: GmailProvider = {
  name: "google",
  authorizeUrl({ clientId, redirectUri, state, codeVerifier }) {
    // RFC 7636: the challenge is base64url(SHA-256(verifier)), not the verifier
    const challenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${GOOGLE_AUTH_URL}?${q.toString()}`;
  },
  async exchangeCode({ clientId, clientSecret, redirectUri, code, codeVerifier }) {
    const res = await fetchJson(
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }).toString(),
      },
    );
    if (!res.ok) throw new DomainError("CONFIG", `Gmail authorisation failed: ${res.errorText || res.status}`);
    const email = await fetchProfileEmail(res.data.access_token);
    return {
      accessToken: String(res.data.access_token),
      refreshToken: res.data.refresh_token ? String(res.data.refresh_token) : null,
      expiresInSec: Number(res.data.expires_in ?? 3600),
      scope: res.data.scope ? String(res.data.scope) : null,
      email,
    };
  },
  async refresh({ clientId, clientSecret, refreshToken }) {
    const res = await fetchJson(
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
      },
    );
    if (!res.ok) throw new DomainError("CONFIG", `Gmail token refresh failed: ${res.errorText || res.status}`);
    return {
      accessToken: String(res.data.access_token),
      // Google omits the refresh token on refresh; keep the stored one
      refreshToken: null,
      expiresInSec: Number(res.data.expires_in ?? 3600),
      scope: res.data.scope ? String(res.data.scope) : null,
      email: null,
    };
  },
  async list({ accessToken, query, maxResults, pageToken }) {
    const q = new URLSearchParams({ q: query, maxResults: String(maxResults), format: "full" });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await fetchJson(`${GOOGLE_API}/messages?${q.toString()}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new DomainError("CONFIG", `Gmail list failed: ${res.errorText || res.status}`);
    const messages = (res.data?.messages ?? []) as Array<{ id: string }>;
    const fetched: RawGmailMessage[] = [];
    for (const m of messages) {
      const one = await googleProvider.get({ accessToken, id: m.id });
      if (one) fetched.push(one);
    }
    return { messages: fetched, nextPageToken: res.data?.nextPageToken ?? null, historyId: res.data?.historyId ?? null };
  },
  async get({ accessToken, id }) {
    const res = await fetchJson(`${GOOGLE_API}/messages/${encodeURIComponent(id)}?format=full`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new DomainError("CONFIG", `Gmail get failed: ${res.errorText || res.status}`);
    }
    return interpret(res.data);
  },
  async getAttachment({ accessToken, messageId, attachmentId }) {
    const res = await fetchJson(
      `${GOOGLE_API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?format=rawData`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new DomainError("CONFIG", `Gmail attachment fetch failed: ${res.errorText || res.status}`);
    const data = decodeBase64Url(res.data?.data);
    if (!data) return null;
    return { bytes: Buffer.from(res.data.data.replace(/-/g, "+").replace(/_/g, "/"), "base64"), mimeType: String(res.data?.mimeType ?? "application/octet-stream") };
  },
  async createDraft({ accessToken, threadId, to, subject, body, inReplyTo }) {
    const mime = [
      `To: ${to}`,
      `Subject: ${subject}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      body,
    ]
      .filter(Boolean)
      .join("\r\n");
    const res = await fetchJson(`${GOOGLE_API}/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { threadId: threadId ?? undefined, raw: Buffer.from(mime, "utf8").toString("base64url") } }),
    });
    if (!res.ok) throw new DomainError("CONFIG", `Gmail draft creation failed: ${res.errorText || res.status}`);
    return { draftId: String(res.data?.id ?? ""), messageId: res.data?.message?.id ? String(res.data.message.id) : null };
  },
};

async function fetchProfileEmail(accessToken: string): Promise<string | null> {
  const res = await fetchJson("https://www.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${accessToken}` } });
  return res.ok && res.data?.emailAddress ? String(res.data.emailAddress) : null;
}

/* ---------------- Fixture (local, deterministic) ---------------- */

interface FixtureState {
  messages: RawGmailMessage[];
  attachments: Map<string, Buffer>;
  drafts: Array<{ draftId: string; to: string; subject: string; body: string; threadId: string | null; inReplyTo: string | null }>;
  failNext: boolean;
}

let fixture: FixtureState = { messages: [], attachments: new Map(), drafts: [], failNext: false };

export function __setFixtureMessages(messages: RawGmailMessage[]): void {
  fixture.messages = messages;
}
export function __addFixtureAttachment(id: string, bytes: Buffer): void {
  fixture.attachments.set(id, bytes);
}
export function __fixtureDrafts() {
  return fixture.drafts;
}
export function __fixtureFailNext(on = true): void {
  fixture.failNext = on;
}
export function __resetGmailFixture(): void {
  fixture = { messages: [], attachments: new Map(), drafts: [], failNext: false };
}

const fixtureProvider: GmailProvider = {
  name: "fixture",
  authorizeUrl() {
    return "/admin/inbox?fixture=connected";
  },
  async exchangeCode() {
    return { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresInSec: 3600, scope: SCOPES, email: "desk@essafaria.local" };
  },
  async refresh() {
    return { accessToken: "fixture-access", refreshToken: null, expiresInSec: 3600, scope: SCOPES, email: null };
  },
  async list({ maxResults }) {
    if (fixture.failNext) throw new DomainError("CONFIG", "fixture provider unavailable");
    // Gmail query operators (in:inbox, newer_than:30d, has:attachment) are not
    // reimplemented here: the fixture mailbox returns what it holds, so the
    // ingest pipeline can be exercised without pretending to be Google's search.
    return { messages: fixture.messages.slice(0, maxResults), nextPageToken: null, historyId: `fixture-${fixture.messages.length}` };
  },
  async get({ id }) {
    return fixture.messages.find((m) => m.id === id) ?? null;
  },
  async getAttachment({ messageId, attachmentId }) {
    const bytes = fixture.attachments.get(`${messageId}:${attachmentId}`) ?? fixture.attachments.get(attachmentId);
    if (!bytes) return null;
    return { bytes, mimeType: "application/octet-stream" };
  },
  async createDraft(input) {
    if (fixture.failNext) throw new DomainError("CONFIG", "fixture provider unavailable");
    const draftId = `draft-${fixture.drafts.length + 1}`;
    fixture.drafts.push({ draftId, ...input });
    return { draftId, messageId: `draft-message-${fixture.drafts.length}` };
  },
};

export function resolveGmailProviderName(): "google" | "fixture" | "none" {
  const e = env() as unknown as Record<string, string | undefined>;
  const raw = (e["GMAIL_PROVIDER"] ?? "").toLowerCase();
  if (raw === "fixture") return "fixture";
  if (raw === "google") return "google";
  if (e["GMAIL_CLIENT_ID_REF"]) return "google";
  return "none";
}

export function getGmailProvider(): GmailProvider {
  const name = resolveGmailProviderName();
  if (name === "fixture") return fixtureProvider;
  if (name === "google") return googleProvider;
  throw new DomainError(
    "CONFIG",
    "Gmail is not configured — set GMAIL_PROVIDER=google with credential references, or GMAIL_PROVIDER=fixture for local testing",
  );
}

export function gmailProviderAvailable(): boolean {
  return resolveGmailProviderName() !== "none";
}
