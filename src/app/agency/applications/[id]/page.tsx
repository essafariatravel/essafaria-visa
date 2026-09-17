import { ApplicationWorkspace } from "@/components/ops/workspace";
import { opActorForPage } from "@/lib/page-auth";
import { loadWorkspaceOr404 } from "@/lib/page-data";

export const dynamic = "force-dynamic";

/** The partner's view of one file: same workspace, staff panels absent, and the
 *  data loaded through the same tenant-scoped services. */
export default async function AgencyApplicationDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { flash?: string };
}) {
  const actor = await opActorForPage("applications.read");
  const data = await loadWorkspaceOr404(actor, params.id);
  return (
    <ApplicationWorkspace
      mode="agency"
      view={data.view}
      checklist={data.checklist}
      applicants={data.applicants}
      timeline={data.timeline}
      transitions={data.transitions}
      invoice={data.invoice}
      wallet={data.wallet}
      priorityOptions={data.priorityOptions}
      flash={searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : undefined}
    />
  );
}
