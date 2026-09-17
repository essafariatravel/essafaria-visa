import { ok, opRoute } from "@/lib/api-ops";
import { listNotificationsForUser, unreadCounts } from "@/lib/notifications";
import { z } from "zod";

export const dynamic = "force-dynamic";

const query = z.object({
  unreadOnly: z.preprocess((v) => v === "1" || v === "true", z.boolean()).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(30),
});

/** GET /api/agency/notifications — scoped to the caller and their agencies. */
export const GET = opRoute({ permission: "notifications.read", agencyFrom: "none" }, async ({ user, query: q }) => {
  const parsed = query.parse(Object.fromEntries(q.entries()));
  const page = parsed.page ?? 1;
  const pageSize = parsed.pageSize ?? 30;
  const { rows, total } = await listNotificationsForUser(
    { id: user.id, agencyIds: user.agencyIds },
    { unreadOnly: parsed.unreadOnly, limit: pageSize, offset: (page - 1) * pageSize },
  );
  const counts = await unreadCounts(user.id);
  return ok({ rows, total, page, pageSize, unread: counts });
});
