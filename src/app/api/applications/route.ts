import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { createApplication, listApplications } from "@/lib/applications";
import { applicationQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * GET  /api/applications — the caller's book of work. Agency users are scoped
 *      to their own rows by the service; staff may filter by agencyId.
 * POST /api/applications — open a file. Staff may name an agency; agencies are
 *      pinned to their membership regardless of what the body says.
 */
export const GET = opRoute({ permission: "applications.read", schema: applicationQuerySchema }, async ({ actor, query }) => {
  const q = applicationQuerySchema.parse(Object.fromEntries(query.entries()));
  const result = await listApplications(actor, {
    q: q.q,
    statusCode: q.statusCode,
    agencyId: q.agencyId,
    visaTypeId: q.visaTypeId,
    priorityId: q.priorityId,
    page: q.page,
    pageSize: q.pageSize,
  });
  return ok(result);
});

export const POST = opRoute(
  {
    permission: "applications.write",
    schema: z.object({
      visaTypeCode: z.string().trim().min(1).max(40).optional(),
      visaTypeId: z.string().trim().min(1).max(64).optional(),
      requestedCount: z.coerce.number().int().min(1).max(50).default(1),
      priorityCode: z.string().trim().max(20).optional(),
      travelDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      notes: z.string().trim().max(4000).optional(),
      agencyId: z.string().trim().min(1).max(64).optional(),
    }),
  },
  async ({ actor, body }) => {
    const created = await createApplication(actor, {
      visaTypeCode: (body.visaTypeCode as string) ?? null,
      visaTypeId: (body.visaTypeId as string) ?? null,
      requestedCount: Number(body.requestedCount ?? 1),
      priorityCode: (body.priorityCode as string) ?? null,
      travelDate: (body.travelDate as string) ?? null,
      notes: (body.notes as string) ?? null,
      agencyId: (body.agencyId as string) ?? null,
    });
    return ok(created, 201);
  },
);
