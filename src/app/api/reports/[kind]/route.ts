import { NextResponse } from "next/server";
import { opRoute } from "@/lib/api-ops";
import { REPORTS, buildReport, toCsv } from "@/lib/reports";
import { DomainError } from "@/lib/ops";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/[kind]?format=csv|json
 *
 * The SAME tenant-scoped query serves both the screen and the export, so an
 * export can never reveal rows the caller could not already list. CSV is
 * formula-escaped on the way out.
 */
export const GET = opRoute({ permission: "reports.read" }, async ({ actor, params, query }) => {
  const kind = String(params.kind ?? "") as keyof typeof REPORTS;
  if (!REPORTS[kind]) throw new DomainError("NOT_FOUND", "Report not found");
  const report = await buildReport(actor, kind, {
    from: query.get("from"),
    to: query.get("to"),
    agencyId: query.get("agencyId"),
    statusCode: query.get("status"),
    limit: query.get("limit") ? Number(query.get("limit")) : 1000,
  });
  if ((query.get("format") ?? "json") === "csv") {
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(toCsv(report), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="essafaria-${kind}-${stamp}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return NextResponse.json(report);
});
