import Link from "next/link";
import { requireStaff } from "@/lib/authorization";
import { getBranding } from "@/lib/config-service";
import { LogoutForm } from "@/app/admin/logout-form";

export const dynamic = "force-dynamic";

const NAV: Array<{ group: string; items: Array<{ href: string; label: string }> }> = [
  {
    group: "Overview",
    items: [
      { href: "/admin", label: "Dashboard" },
      { href: "/admin/audit", label: "Audit Log" },
    ],
  },
  {
    group: "Operations",
    items: [
      { href: "/admin/applications", label: "Applications" },
      { href: "/admin/wallet", label: "Agency wallets" },
      { href: "/admin/inbox", label: "Gmail intake" },
      { href: "/admin/copilot", label: "Desk copilot" },
      { href: "/admin/agencies", label: "Agencies" },
      { href: "/admin/users", label: "Users" },
    ],
  },
  {
    group: "Visa Catalog",
    items: [
      { href: "/admin/countries", label: "Countries" },
      { href: "/admin/visa-categories", label: "Visa Categories" },
      { href: "/admin/visa-types", label: "Visa Types" },
      { href: "/admin/document-types", label: "Document Types" },
      { href: "/admin/fees", label: "Fees & Pricing" },
      { href: "/admin/currencies", label: "Currencies" },
    ],
  },
  {
    group: "Workflow",
    items: [
      { href: "/admin/statuses", label: "Application Statuses" },
      { href: "/admin/priorities", label: "Priorities" },
      { href: "/admin/templates", label: "Communication" },
    ],
  },
  {
    group: "Website",
    items: [
      { href: "/admin/homepage", label: "Homepage" },
      { href: "/admin/navigation", label: "Navigation" },
      { href: "/admin/legal", label: "Legal Pages" },
      { href: "/admin/branding", label: "Branding" },
      { href: "/admin/media", label: "Media Library" },
    ],
  },
  {
    group: "Insight",
    items: [
      { href: "/admin/reports", label: "Reports & exports" },
      { href: "/admin/automation", label: "Automation" },
    ],
  },
  {
    group: "System",
    items: [
      { href: "/admin/settings", label: "Site Settings" },
      { href: "/admin/health", label: "System health" },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireStaff();
  const branding = await getBranding().catch(() => null);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800 bg-[#10151f] text-slate-200 md:flex">
        <div className="border-b border-slate-800 px-5 py-4">
          <Link href="/admin" className="block">
            <span className="text-lg font-bold tracking-wide text-white">
              {branding?.brandName ?? "ESSAFARIA"}
            </span>
            <span className="mt-0.5 block text-[11px] uppercase tracking-[0.2em] text-slate-400">
              Visa OS · Admin
            </span>
          </Link>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {NAV.map((section) => (
            <div key={section.group} className="mb-5">
              <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                {section.group}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="block rounded-md px-2 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="border-t border-slate-800 px-4 py-3 text-xs text-slate-400">
          <p className="font-semibold text-slate-200">{user.name}</p>
          <p>{user.role.replace(/_/g, " ").toLowerCase()}</p>
          <div className="mt-2 flex gap-3">
            <Link href="/" className="hover:text-white">
              View site
            </Link>
            <LogoutForm />
          </div>
        </div>
      </aside>
      <main id="main" className="min-w-0 flex-1">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm">
          Skip to content
        </a>
        <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">{children}</div>
      </main>
    </div>
  );
}
