import { z } from "zod";
import { opRoute, ok } from "@/lib/api-ops";
import { linkAttachmentToApplication } from "@/lib/gmail";
import { buildActor } from "@/lib/guard";

export const dynamic = "force-dynamic";

const body = z.object({
  attachmentId: z.string().trim().min(1).max(64),
  applicationId: z.string().trim().min(1).max(64),
  documentTypeCode: z.string().trim().min(2).max(40),
  applicantId: z.string().trim().max(64).optional(),
});

/** POST /api/gmail/messages/[id]/link — a staff member confirms the import. */
export const POST = opRoute({ permission: "applications.review", staffOnly: true, allowAgency: false, schema: body }, async ({ user, params, body: b }) => {
  const parsed = body.parse(b);
  const actor = buildActor(user, "applications.review");
  const res = await linkAttachmentToApplication(actor, { ...parsed, applicantId: parsed.applicantId ?? null });
  return ok(res);
});
