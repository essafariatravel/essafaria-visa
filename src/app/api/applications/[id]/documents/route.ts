import { z } from "zod";
import { NextResponse } from "next/server";
import { ok, opRoute } from "@/lib/api-ops";
import { listDocuments, uploadDocument } from "@/lib/documents";
import { DOCUMENT_MAX_BYTES } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * GET  /api/applications/[id]/documents — the file's documents (newest first).
 * POST /api/applications/[id]/documents — multipart upload:
 *      `file` plus documentTypeCode (or documentTypeId), applicantId,
 *      agencyNotes. Content type, size and checklist membership are all
 *      re-derived server-side; nothing about the upload is taken on trust.
 */
export const GET = opRoute({ permission: "applications.read" }, async ({ actor, params }) => {
  return ok({ documents: await listDocuments(actor, params.id) });
});

const fields = z.object({
  documentTypeCode: z.string().trim().max(40).optional(),
  documentTypeId: z.string().trim().max(64).optional(),
  applicantId: z.string().trim().max(64).optional(),
  agencyNotes: z.string().trim().max(2000).optional(),
});

export const POST = opRoute(
  { permission: "documents.upload", multipart: true, maxUploadBytes: DOCUMENT_MAX_BYTES },
  async ({ actor, params, body, file }) => {
    if (!file) return NextResponse.json({ error: "A file is required" }, { status: 422 });
    const parsed = fields.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
        { status: 422 },
      );
    }
    const result = await uploadDocument(actor, params.id, {
      bytes: file.bytes,
      filename: file.name,
      claimedMime: file.type,
      documentTypeCode: parsed.data.documentTypeCode ?? null,
      documentTypeId: parsed.data.documentTypeId ?? null,
      applicantId: parsed.data.applicantId ?? null,
      agencyNotes: parsed.data.agencyNotes ?? null,
      source: actor.isStaff ? "BACK_OFFICE" : "PORTAL",
    });
    return NextResponse.json(result, { status: 201 });
  },
);
