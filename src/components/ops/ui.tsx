import Link from "next/link";
import { formatMoney } from "@/lib/config-service";
import { Badge } from "@/components/admin/ui";

/* ============================================================
 * Operational UI kit.
 *
 * Deliberately server-rendered: no client components, no state machines in the
 * browser. Every control here is a form or a link whose real behaviour lives in
 * a service that re-checks permissions and tenancy — hiding a control is
 * presentation, never the security boundary.
 * ============================================================ */

export function Money({ cents, code }: { cents: number; code: string }) {
  return <span className="tabular-nums whitespace-nowrap">{formatMoney(Number(cents || 0), code)}</span>;
}

export function StatusChip({ label, color }: { label: string; color: string | null }) {
  const c = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#475569";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ background: `${c}18`, color: c, boxShadow: `inset 0 0 0 1px ${c}30` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} aria-hidden />
      {label}
    </span>
  );
}

const STATE_TONE: Record<string, { label: string; tone: "slate" | "green" | "red" | "amber" | "navy" }> = {
  MISSING: { label: "Missing", tone: "red" },
  PENDING_REVIEW: { label: "In review", tone: "amber" },
  ACCEPTED: { label: "Accepted", tone: "green" },
  REJECTED: { label: "Rejected", tone: "red" },
  EXPIRED: { label: "Expired", tone: "red" },
  NEEDS_REPLACEMENT: { label: "Replace", tone: "amber" },
  NOT_APPLICABLE: { label: "Optional", tone: "slate" },
};

export function StateChip({ state }: { state: string }) {
  const s = STATE_TONE[state] ?? { label: state, tone: "slate" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  tight,
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  tight?: boolean;
}) {
  return (
    <section className={`card ${tight ? "p-4" : "p-5"} mb-6`}>
      {(title || action) && (
        <header className={`flex flex-wrap items-start justify-between gap-3 ${title && children ? "mb-4" : ""}`}>
          <div>
            {title ? (
              <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-700">{title}</h2>
            ) : null}
            {subtitle ? <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">{subtitle}</p> : null}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function KeyVal({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="min-w-0 border-b border-slate-100 pb-2">
          <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{k}</dt>
          <dd className="mt-1 truncate text-sm font-medium text-slate-800">{v ?? <span className="text-slate-400">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  hint,
  options,
  as = "input",
  rows = 4,
  accept,
  step,
  disabled,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | boolean | null;
  required?: boolean;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  as?: "input" | "select" | "textarea" | "checkbox" | "file";
  rows?: number;
  accept?: string;
  step?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = `f-${name.replace(/[^a-zA-Z0-9]/g, "-")}`;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label">
        {label}
        {required ? <span className="ml-1 text-brand-accent">*</span> : null}
      </label>
      {as === "select" ? (
        <select id={id} name={name} className="input" defaultValue={String(defaultValue ?? "")} required={required} disabled={disabled}>
          <option value="">—</option>
          {(options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : as === "textarea" ? (
        <textarea id={id} name={name} rows={rows} className="input" defaultValue={typeof defaultValue === "string" ? defaultValue : ""} required={required} disabled={disabled} />
      ) : as === "checkbox" ? (
        <label htmlFor={id} className="flex items-center gap-2 text-sm text-slate-700">
          <input id={id} type="checkbox" name={name} value="on" defaultChecked={Boolean(defaultValue)} disabled={disabled} />
          <span>{hint ?? label}</span>
        </label>
      ) : as === "file" ? (
        <input id={id} type="file" name={name} accept={accept} required={required} className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-700" disabled={disabled} />
      ) : (
        <input
          id={id}
          type={type}
          name={name}
          step={step}
          className="input"
          defaultValue={defaultValue === null || defaultValue === undefined ? "" : String(defaultValue)}
          required={required}
          disabled={disabled}
        />
      )}
      {hint && as !== "checkbox" && as !== "file" ? <p className="mt-1 text-[11px] leading-snug text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function Form({
  action,
  children,
  submitLabel = "Save",
  back,
  applicationId,
  tone = "brand",
  confirm,
  extra,
}: {
  action: (fd: FormData) => Promise<void>;
  children?: React.ReactNode;
  submitLabel?: string;
  back?: string;
  applicationId?: string;
  tone?: "brand" | "ghost" | "danger";
  confirm?: string;
  extra?: React.ReactNode;
}) {
  const btn =
    tone === "danger"
      ? "rounded-md border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
      : tone === "ghost"
        ? "rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
        : "btn-brand !px-4 !py-2 text-xs";
  return (
    <form action={action} className="space-y-4" {...(confirm ? { "data-confirm": confirm } : {})}>
      {back ? <input type="hidden" name="__back" value={back} /> : null}
      {applicationId ? <input type="hidden" name="__applicationId" value={applicationId} /> : null}
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={btn}>
          {submitLabel}
        </button>
        {extra}
      </div>
    </form>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (p: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) {
    return <p className="mt-4 text-xs text-slate-500">{total} record{total === 1 ? "" : "s"}</p>;
  }
  const window: number[] = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) window.push(p);
  return (
    <nav className="mt-4 flex flex-wrap items-center gap-2 text-xs" aria-label="Pagination">
      <span className="text-slate-500">
        {total} record{total === 1 ? "" : "s"} · page {page} of {pages}
      </span>
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className="rounded-md border border-slate-200 px-2 py-1 font-semibold text-slate-600 hover:bg-slate-100">
          Previous
        </Link>
      ) : null}
      {window.map((p) => (
        <Link
          key={p}
          href={hrefFor(p)}
          aria-current={p === page ? "page" : undefined}
          className={`rounded-md px-2 py-1 font-semibold ${p === page ? "bg-[var(--color-brand-secondary)] text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-100"}`}
        >
          {p}
        </Link>
      ))}
      {page < pages ? (
        <Link href={hrefFor(page + 1)} className="rounded-md border border-slate-200 px-2 py-1 font-semibold text-slate-600 hover:bg-slate-100">
          Next
        </Link>
      ) : null}
    </nav>
  );
}

export function FilterBar({
  tabs,
  base,
  params,
  search,
}: {
  tabs: Array<{ label: string; count?: number; href: string; active: boolean }>;
  base: string;
  params: Record<string, string | undefined>;
  search: string;
}) {
  const hrefWith = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { ...params, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
              t.active ? "bg-[var(--color-brand-secondary)] text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {t.label}
            {typeof t.count === "number" ? (
              <span className={`tabular-nums ${t.active ? "text-white/70" : "text-slate-400"}`}>{t.count}</span>
            ) : null}
          </Link>
        ))}
      </div>
      <form action={base} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <label className="label" htmlFor="q">
            Search
          </label>
          <input id="q" name="q" defaultValue={search} className="input" placeholder="Reference, traveller country, agency, notes…" />
        </div>
        <button type="submit" className="btn-brand !px-4 !py-2 text-xs">
          Search
        </button>
        {search ? <Link href={hrefWith({ q: undefined })} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">Clear</Link> : null}
      </form>
    </div>
  );
}

export function Notice({ kind, children }: { kind: "info" | "warn" | "error" | "ai"; children: React.ReactNode }) {
  const map = {
    info: "border-slate-200 bg-slate-50 text-slate-700",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-800",
    ai: "border-indigo-200 bg-indigo-50/60 text-indigo-900",
  } as const;
  return (
    <p className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${map[kind]}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export function StatCard({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "warn" | "ok" }) {
  return (
    <div className="card p-4">
      <p className={`text-2xl font-black tracking-tight ${tone === "warn" ? "text-red-600" : tone === "ok" ? "text-emerald-700" : ""}`} style={tone ? undefined : { color: "var(--color-brand-primary)" }}>
        {value}
      </p>
      <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</p>
      {hint ? <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{hint}</p> : null}
    </div>
  );
}

/** AI output is always visually separated from authoritative data. */
export function AiNote({ children, confidence, basis }: { children: React.ReactNode; confidence?: number | null; basis?: string[] }) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
      <p className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-indigo-700">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden />
        AI assist — advisory only
        {typeof confidence === "number" ? <span className="ml-auto rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">confidence {confidence}%</span> : null}
      </p>
      <div className="text-xs leading-relaxed text-indigo-950">{children}</div>
      {basis?.length ? <p className="mt-2 text-[10px] text-indigo-700/70">Based on: {basis.join(" · ")}</p> : null}
      <p className="mt-2 text-[10px] italic text-indigo-700/70">Never a decision. A staff member must act for anything here to change a file.</p>
    </div>
  );
}
