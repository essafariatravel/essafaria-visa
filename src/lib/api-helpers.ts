import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/authorization";
import type { Permission } from "@/lib/rbac";
import type { SessionUser } from "@/lib/session";

/** Wraps an admin API handler with authentication + permission check. */
export function withAuth<P>(
  permission: Permission,
  handler: (req: Request, user: SessionUser, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: { params?: P }) => {
    try {
      const user = await requirePermission(permission);
      return await handler(req, user, (ctx.params ?? {}) as P);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        const status = err.message === "Authentication required" ? 401 : 403;
        return NextResponse.json({ error: err.message }, { status });
      }
      throw err;
    }
  };
}

export function jsonError(message: string, status = 400, issues?: string[]) {
  return NextResponse.json({ error: message, issues }, { status });
}

export class HttpError extends Error {
  status: number;
  issues?: string[];
  constructor(status: number, message: string, issues?: string[]) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

export function fail(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message, issues: err.issues }, { status: err.status });
  }
  const name = (err as { name?: string })?.name;
  if (name === "ValidationError" && Array.isArray((err as { issues?: string[] }).issues)) {
    const e = err as { issues: string[] };
    return NextResponse.json({ error: "Validation failed", issues: e.issues }, { status: 422 });
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Unique-violation messages are useful to admins surfacing conflicts.
  if (/duplicate key|violates unique constraint/i.test(msg)) {
    return NextResponse.json({ error: "Duplicate value — this code/label already exists." }, { status: 409 });
  }
  if (/violates foreign key constraint|constraint .* from deletion/i.test(msg)) {
    return NextResponse.json(
      { error: "This record is referenced by other data — deactivate it instead of deleting." },
      { status: 409 },
    );
  }
  console.error("[api] unhandled error:", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") throw new HttpError(400, "JSON body required");
  return body as Record<string, unknown>;
}
