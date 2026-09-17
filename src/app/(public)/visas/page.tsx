import { getVisaCatalog } from "@/lib/config-service";
import { PageShell } from "@/components/site/shell";
import { VisaExplorer } from "@/app/(public)/visas/explorer";

export const dynamic = "force-dynamic";

export default async function VisasPage() {
  const catalog = await getVisaCatalog().catch(() => []);
  return (
    <PageShell
      title="Visa Services"
      subtitle="Every route below is configured in the admin panel — countries, processing times and service pricing are data, not code."
    >
      <VisaExplorer catalog={catalog} />
    </PageShell>
  );
}
