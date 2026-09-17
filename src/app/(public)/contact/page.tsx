import { getSetting, getBranding } from "@/lib/config-service";
import { PageShell } from "@/components/site/shell";

export const dynamic = "force-dynamic";

async function row(label: string, key: string, hrefPrefix?: string) {
  const value = await getSetting<string>(key, "");
  if (!value) return null;
  return (
    <div key={key} className="flex justify-between gap-6 border-b border-slate-100 py-2.5 text-sm">
      <span className="font-semibold text-slate-500">{label}</span>
      {hrefPrefix ? (
        <a href={`${hrefPrefix}${value}`} className="font-medium underline decoration-dotted" style={{ color: "var(--color-brand-primary)" }}>
          {value}
        </a>
      ) : (
        <span className="text-right text-slate-700">{value}</span>
      )}
    </div>
  );
}

export default async function ContactPage() {
  const branding = await getBranding().catch(() => null);
  const rows = await Promise.all([
    row("Email", "contact.email", "mailto:"),
    row("Support", "contact.supportEmail", "mailto:"),
    row("Sales (B2B)", "contact.salesEmail", "mailto:"),
    row("Phone", "contact.phone", "tel:"),
    row("WhatsApp", "contact.whatsapp", "tel:"),
    row("Address", "contact.address"),
    row("City", "contact.city"),
    row("Business hours", "contact.businessHours"),
  ]);
  const visible = rows.filter(Boolean);

  return (
    <PageShell title="Contact" subtitle="Partner desk for travel agencies — new accounts, pricing and file escalations.">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="card p-6">
          <h2 className="mb-2 font-bold" style={{ color: "var(--color-brand-secondary)" }}>
            {branding?.companyName ?? "ESSAFARIA TRAVEL"}
          </h2>
          {visible.length ? visible : <p className="py-6 text-sm text-slate-400">Contact details are configured in Admin → Site Settings.</p>}
        </div>
        <div className="card flex flex-col justify-between p-6" style={{ background: "var(--color-brand-secondary)" }}>
          <div className="text-white">
            <h2 className="font-bold">Not a partner yet?</h2>
            <p className="mt-2 text-sm text-white/75">
              Agencies get portal access, per-country requirement checklists, B2B pricing and tracked files. Onboarding usually takes one business
              day.
            </p>
          </div>
          <a href="/login" className="btn-brand mt-6 !bg-white !text-slate-900 self-start">
            Open an agency account
          </a>
        </div>
      </div>
    </PageShell>
  );
}
