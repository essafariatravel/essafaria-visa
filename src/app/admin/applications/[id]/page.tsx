import { ApplicationWorkspace } from "@/components/ops/workspace";
import { staffActorForPage } from "@/lib/page-auth";
import { loadWorkspaceOr404 } from "@/lib/page-data";

export const dynamic = "force-dynamic";

/** Back-office view of one file: staff panels plus the agency-visible content. */
export default async function AdminApplicationDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { flash?: string };
}) {
  const actor = await staffActorForPage("applications.read");
  const data = await loadWorkspaceOr404(actor, params.id);
  return (
    <ApplicationWorkspace
      mode="staff"
      view={data.view}
      checklist={data.checklist}
      applicants={data.applicants}
      timeline={data.timeline}
      transitions={data.transitions}
      invoice={data.invoice}
      wallet={data.wallet}
      staffOptions={data.staffOptions}
      priorityOptions={data.priorityOptions}
      flash={searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : undefined}
    />
  );
}
