import { formatMoney, getVisaTypeDetail, type VisaCatalogRow } from "@/lib/config-service";

/* Lists the active visa catalog; expandable detail with the live
 * requirements checklist from visa_requirements + document types. */

export async function VisaExplorer({ catalog }: { catalog: VisaCatalogRow[] }) {
  const grouped = new Map<string, VisaCatalogRow[]>();
  for (const v of catalog) {
    if (!grouped.has(v.countryName)) grouped.set(v.countryName, []);
    grouped.get(v.countryName)!.push(v);
  }

  if (catalog.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center text-sm text-slate-500">
        No visa routes are configured yet. Add countries and visa types in the admin panel — this page updates automatically.
      </p>
    );
  }

  return (
    <div className="space-y-10">
      {[...grouped.entries()].map(([country, types]) => (
        <section key={country}>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-brand-primary)]">{country}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {types.map(async (t) => {
              const detail = await getVisaTypeDetail(t.id);
              const serviceFee = detail?.fees.find((f) => f.feeType === "SERVICE_FEE");
              return (
                <details key={t.id} className="card group p-4">
                  <summary className="flex cursor-pointer items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{t.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {t.categoryName ?? "Visa"} · {t.processingTimeDays ?? "—"} business days
                        {serviceFee ? ` · ${formatMoney(serviceFee.amountCents, serviceFee.currencyCode)} service` : ""}
                      </p>
                    </div>
                    <span className="text-xs font-bold text-slate-400 group-open:rotate-90 transition-transform">▸</span>
                  </summary>
                  {t.description ? <p className="mt-3 text-sm text-slate-600">{t.description}</p> : null}
                  {detail && detail.requirements.length > 0 ? (
                    <div className="mt-3 rounded-lg bg-slate-50 p-3">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Required documents</p>
                      <ul className="space-y-1 text-xs text-slate-600">
                        {detail.requirements.map((r) => (
                          <li key={r.id} className="flex gap-2">
                            <span className={r.isRequired ? "text-red-500" : "text-slate-300"}>{r.isRequired ? "●" : "○"}</span>
                            <span>
                              {r.documentName} {r.instructions ? <span className="text-slate-400">— {r.instructions}</span> : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {detail?.eligibilityNotes ? (
                    <p className="mt-3 text-xs italic text-slate-400">{detail.eligibilityNotes}</p>
                  ) : null}
                </details>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
