import { z } from "zod";
import { ok, opRoute } from "@/lib/api-ops";
import { withdrawDocument } from "@/lib/documents";

export const dynamic = "force-dynamic";

const body = z.object({ reason: z.string().trim().min(5).max(2000) });

export const POST = opRoute(
  { permission: "applications.review", staffOnly: true, allowAgency: false, schema: body },
  async ({ actor, params, body: b }) => {
    const parsed = body.parse(b);
    await withdrawDocument(actor, params.id, parsed.reason);
    return ok({ withdrawn: true });
  },
);
