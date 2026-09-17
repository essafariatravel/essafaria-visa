import Link from "next/link";
import { PageHeader } from "@/components/admin/ui";
import { Field, Form, Notice, Panel } from "@/components/ops/ui";
import { createApplicationAction } from "@/app/ops-actions";
import { priorityOptions, visaTypeOptions } from "@/lib/options";
import { opActorForPage } from "@/lib/page-auth";

export const dynamic = "force-dynamic";

/** Intake form: the route selection immediately determines the checklist and price. */
export default async function AgencyNewApplicationPage({ searchParams }: { searchParams: { flash?: string } }) {
  await opActorForPage("applications.write");
  const [visaTypes, priorities] = await Promise.all([visaTypeOptions(), priorityOptions()]);
  const flash = searchParams.flash ? decodeURIComponent(searchParams.flash).replace(/^(ok|err):/, "") : null;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="New visa application"
        subtitle="One file can carry up to 50 travellers. Each traveller gets their own document checklist for the requirements of the route you select."
        action={
          <Link href="/agency/applications" className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
            Cancel
          </Link>
        }
      />
      {flash ? (
        <div className="mb-4">
          <Notice kind={searchParams.flash?.startsWith("err") ? "error" : "info"}>{flash}</Notice>
        </div>
      ) : null}
      <Panel>
        <Form action={createApplicationAction} submitLabel="Create application" back="/agency/applications/new">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field as="select" name="visaTypeId" label="Visa route" options={visaTypes} required />
            <Field name="requestedCount" type="number" label="Number of travellers" defaultValue={1} required />
            <Field as="select" name="priorityId" label="Priority" options={priorities} hint="Urgent handling may carry a surcharge on the service fee" />
            <Field name="travelDate" type="date" label="Intended travel date" />
          </div>
          <Field as="textarea" name="notes" label="Anything the desk should know" rows={3} />
          <p className="text-[11px] text-slate-400">
            You will add travellers and upload documents on the next screen, where their passport details drive the checklist.
          </p>
        </Form>
      </Panel>
    </div>
  );
}
