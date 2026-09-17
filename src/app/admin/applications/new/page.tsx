import Link from "next/link";
import { PageHeader } from "@/components/admin/ui";
import { Field, Form, Panel } from "@/components/ops/ui";
import { createApplicationAction } from "@/app/ops-actions";
import { agencyOptions, priorityOptions, visaTypeOptions } from "@/lib/options";
import { staffActorForPage } from "@/lib/page-auth";

export const dynamic = "force-dynamic";

/** Back-office intake: open a file on behalf of a partner agency. */
export default async function NewAdminApplicationPage({ searchParams }: { searchParams: { flash?: string; agencyId?: string } }) {
  await staffActorForPage("applications.write");
  const [agencies, visaTypes, priorities] = await Promise.all([agencyOptions(), visaTypeOptions(), priorityOptions()]);
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash) : null;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="New application"
        subtitle="The route decides everything that follows: its configured requirements build the checklist, its effective fees price the file, and both are frozen onto the record so a later configuration change cannot rewrite history."
        action={
          <Link href="/admin/applications" className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
            Cancel
          </Link>
        }
      />
      {flash ? (
        <p className={`mb-4 rounded-lg border px-3 py-2 text-xs ${flash.startsWith("err") ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          {flash.replace(/^(ok|err):/, "")}
        </p>
      ) : null}
      <Panel>
        <Form action={createApplicationAction} submitLabel="Open file" back="/admin/applications/new">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field as="select" name="agencyId" label="Partner agency" options={agencies} required hint="Files always belong to exactly one agency; the portal shows them only there" />
            <Field as="select" name="visaTypeId" label="Visa route" options={visaTypes} required />
            <Field name="requestedCount" type="number" label="Number of travellers" defaultValue={1} required hint="1–50 per file; pricing multiplies by this count" />
            <Field as="select" name="priorityId" label="Priority" options={priorities} hint="Priority surcharges apply to service fees only" />
            <Field name="travelDate" type="date" label="Intended travel date" />
          </div>
          <Field as="textarea" name="notes" label="Note for the file (visible to the agency)" rows={3} />
        </Form>
      </Panel>
    </div>
  );
}
