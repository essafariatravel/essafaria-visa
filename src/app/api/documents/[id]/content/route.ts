import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { describeDomainError } from "@/lib/ops";
import { openDocumentContent } from "@/lib/documents";
import { csrfGuard } from "@/lib/api-ops";

export const dynamic = "force-dynamic";

/**
 * GET /api/documents/[id]/content — the ONLY way document bytes are served.
 *
 * Proves session → capability → document → application → agency, then streams
 * inline with a download-safe disposition. Bytes are never public, never
 * cacheable by a shared cache, and every read is audited.
 */
export async function GET(req: Request, ctx: { params: { id: string } }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    const doc = await openDocumentContent({ documentId: ctx.params.id }, user);
    return new NextResponse(new Uint8Array(doc.buffer), {
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Length": String(doc.buffer.length),
        // inline so a PDF renders in a tab, but never framed by another origin
        "Content-Disposition": `inline; filename="${doc.filename.replace(/["\r\n]/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err) {
    const { status, message } = describeDomainError(err);
    return NextResponse.json({ error: message }, { status });
  }
}
