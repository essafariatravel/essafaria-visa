import { getDb, siteSettings } from "@/db";
import { requireStaff } from "@/lib/authorization";
import { can } from "@/lib/rbac";
import { SETTING_DEFINITIONS } from "@/lib/validation";
import { saveSettingAction } from "@/app/admin/actions";
import { Flash } from "@/app/admin/flash";
import { PageHeader } from "@/components/admin/ui";
import { asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const CATEGORIES = ["GENERAL", "CONTACT", "SOCIAL", "EMAIL", "VISA", "NOTIFICATIONS", "OPERATIONS", "AI", "GMAIL", "SECURITY"] as const;

const CATEGORY_LABELS: Record<string, string> = {
  GENERAL: "Company",
  CONTACT: "Contact information",
  SOCIAL: "Social links",
  EMAIL: "Outbound email",
  VISA: "Visa defaults",
  NOTIFICATIONS: "Notifications",
  OPERATIONS: "Workflow & money",
  AI: "AI assistant",
  GMAIL: "Gmail intake",
  SECURITY: "Security",
};

function inputTypeFor(key: string): string {
  if (key.includes("Email") || key.includes("email")) return "email";
  if (key.includes("website") || key.startsWith("social.")) return "url";
  if (key.includes("phone") || key.includes("whatsapp")) return "tel";
  if (key.includes("Currency")) return "text";
  if (key.includes("Days") || key.includes("session") || key.includes("Cents") || key.includes("Percent") || key.includes("Minutes")) return "number";
  if (key.includes("enabled") || key.includes("Allow") || key.includes("allow") || key.includes("Self") || key.includes("auto")) return "text";
  return "text";
}

export default async function SettingsPage(props: { searchParams: { flash?: string; cat?: string } }) {
  const user = await requireStaff();
  const mayWrite = can(user.role, "settings.write");
  const db = await getDb();
  const rows = await db.select().from(siteSettings).orderBy(asc(siteSettings.key));
  const byKey = new Map(rows.map((r) => [r.key, r]));

  return (
    <div>
      <Flash searchParams={props.searchParams} />
      <PageHeader
        title="Site Settings"
        subtitle="Central company configuration. Every value is stored as a validated setting row and consumed live by the website, portal and admin."
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <a
            key={c}
            href={`/admin/settings?cat=${c}`}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              !props.searchParams.cat || props.searchParams.cat === c
                ? "bg-[var(--color-brand-secondary)] text-white"
                : "bg-white text-slate-600 ring-1 ring-slate-200"
            }`}
          >
            {CATEGORY_LABELS[c]}
          </a>
        ))}
      </div>

      <div className="space-y-6">
        {CATEGORIES.filter((c) => !props.searchParams.cat || c === props.searchParams.cat).map((cat) => {
          const entries = Object.entries(SETTING_DEFINITIONS).filter(([, def]) => def.category === cat);
          if (entries.length === 0) return null;
          return (
            <section key={cat} className="card p-5">
              <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-slate-600">{CATEGORY_LABELS[cat]}</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {entries.map(([key, def]) => {
                  const stored = byKey.get(key);
                  const value = stored ? String(stored.value ?? "") : "";
                  return (
                    <div key={key} className="rounded-lg border border-slate-200 p-3">
                      <p className="label mb-1">{def.label}</p>
                      <p className="mb-2 font-mono text-[10px] text-slate-400">{key}</p>
                      {mayWrite ? (
                        <form action={saveSettingAction} className="flex items-end gap-2">
                          <input type="hidden" name="key" value={key} />
                          <input type="hidden" name="category" value={cat} />
                          {typeof stored?.value === "boolean" || key.includes("enabled") ? (
                            <select name="value" className="input" defaultValue={value === "false" ? "false" : "true"}>
                              <option value="true">enabled</option>
                              <option value="false">disabled</option>
                            </select>
                          ) : (
                            <input
                              name="value"
                              type={inputTypeFor(key)}
                              className="input"
                              defaultValue={value}
                              placeholder="not set"
                            />
                          )}
                          <button type="submit" className="btn-brand whitespace-nowrap !px-3 !py-2 text-xs">
                            Save
                          </button>
                        </form>
                      ) : (
                        <p className="text-sm text-slate-600">{value || <span className="italic text-slate-400">not set</span>}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
