import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, type SessionUser } from "@/lib/session";
import { buildActor, buildStaffActor, type OpActor } from "@/lib/guard";
import { describeDomainError } from "@/lib/ops";
import { can, type Permission } from "@/lib/rbac";
import { isAgencyRole } from "@/lib/tenancy";

type Q = any;

/* ============================================================
 * HTTP layer for the operational API.
 *
 * One wrapper, so every route gets the same guarantees:
 *   • session-only identity (never a header, query param or cookie besides
 *     the session token itself)
 *   • capability check, then tenant pinning inside buildActor()
 *   • same-origin check for every mutating request (defence in depth
 *     alongside the httpOnly SameSite=Lax session cookie)
 *   • errors mapped through the single DomainError taxonomy — no SQL text,
 *     stack traces or internal identifiers in responses
 *
 * Handlers receive the validated JSON body and the built actor. They cannot
 * accidentally forget authorization, because the actor is a required argument.
 * ============================================================ */

export interface OpRequest<Ctx> {
  req: Request;
  params: Ctx;
  user: SessionUser;
  actor: OpActor;
  body: Record<string, unknown>;
  query: URLSearchParams;
  /** present for multipart routes only */
  file?: { name: string; bytes: Buffer; type: string };
}

export interface OpRouteOptions<Ctx> {
  permission: Permission;
  /** staff-only routes (wallet funding, assignment, overrides) */
  staffOnly?: boolean;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** body schema; for GET the query string is validated with the same schema */
  schema?: z.ZodTypeAny;
  /** agency scope: read from body/query (staff may name one; agencies are pinned) */
  agencyFrom?: "body" | "query" | "none";
  /** also allow acting through the agency portal (default true) */
  allowAgency?: boolean;
  /** read multipart/form-data instead of JSON (file uploads) */
  multipart?: boolean;
  /** reject a multipart upload larger than this */
  maxUploadBytes?: number;
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Same-origin check. Returns an error response when a cross-origin mutation
 *  is attempted; missing Origin (same-origin GET, curl, health probes) passes. */
export function csrfGuard(req: Request): NextResponse | null {
  if (!MUTATING.has(req.method.toUpperCase())) return null;
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const source = origin ?? referer;
  if (!source) return null;
  try {
    const src = new URL(source);
    const host = req.headers.get("host") ?? new URL(req.url).host;
    if (src.host !== host) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Malformed Origin header" }, { status: 400 });
  }
  return null;
}

function failFrom(err: unknown) {
  const { status, message, issues } = describeDomainError(err);
  return NextResponse.json({ error: message, ...(issues?.length ? { issues } : {}) }, { status });
}

export function opRoute<Ctx = Record<string, string>>(
  options: OpRouteOptions<Ctx>,
  handler: (r: OpRequest<Ctx>) => Promise<Response>,
) {
  return async (req: Request, ctx: { params?: Ctx }) => {
    const csrf = csrfGuard(req);
    if (csrf) return csrf;
    try {
      const user = await getSessionUser();
      if (!user) {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
      }
      if (!can(user.role, options.permission)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (options.allowAgency === false && isAgencyRole(user.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const query = new URL(req.url).searchParams;
      const isGet = ["GET", "HEAD"].includes(req.method.toUpperCase());
      let raw: Record<string, unknown> = {};
      let file: OpRequest<Ctx>["file"];
      if (!isGet && options.multipart) {
        const form = await req.formData().catch(() => null);
        if (!form) return NextResponse.json({ error: "multipart/form-data body required" }, { status: 400 });
        const fields: Record<string, unknown> = {};
        for (const [k, v] of form.entries()) {
          if (typeof v === "string") fields[k] = v;
          else if (!file) {
            const bytes = Buffer.from(await v.arrayBuffer());
            const cap = options.maxUploadBytes ?? 25 * 1024 * 1024;
            if (bytes.length > cap) {
              return NextResponse.json({ error: `File is too large (limit ${Math.floor(cap / 1024 / 1024)} MB)` }, { status: 413 });
            }
            file = { name: v.name ?? "upload", bytes, type: v.type ?? "application/octet-stream" };
          }
        }
        raw = fields;
      } else if (!isGet) {
        const body = await req.json().catch(() => null);
        if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
          return NextResponse.json({ error: "JSON object body required" }, { status: 400 });
        }
        raw = (body ?? {}) as Record<string, unknown>;
      }
      const source = isGet ? Object.fromEntries(query.entries()) : raw;
      let parsed = source;
      if (options.schema) {
        const res = options.schema.safeParse(source);
        if (!res.success) {
          return NextResponse.json(
            {
              error: "Validation failed",
              issues: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            },
            { status: 422 },
          );
        }
        parsed = res.data as Record<string, unknown>;
      }
      const namedAgency =
        options.agencyFrom === "none"
          ? null
          : ((parsed.agencyId as string | undefined) ?? (query.get("agencyId") ?? undefined)) ?? null;
      const actor = options.staffOnly
        ? buildStaffActor(user, options.permission, { agencyId: namedAgency ?? null })
        : buildActor(user, options.permission, { onBehalfOfAgencyId: namedAgency });
      return await handler({ req, params: (ctx.params ?? {}) as Ctx, user, actor, body: raw, query, file });
    } catch (err) {
      return failFrom(err);
    }
  };
}

/** JSON helper that keeps error shape identical everywhere. */
export function ok(data: unknown, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}

export { z };
