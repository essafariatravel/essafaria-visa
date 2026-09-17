import Link from "next/link";
import { getBranding } from "@/lib/config-service";

export default async function NotFound() {
  const branding = await getBranding().catch(() => null);
  return (
    <main className="flex min-h-screen items-center justify-center px-4" style={{ background: "var(--color-brand-background)" }}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">{branding?.brandName ?? "ESSAFARIA"} · not found</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight" style={{ color: "var(--color-brand-secondary)" }}>
          There is nothing at this address
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          The record may belong to another agency, may have been renamed, or the link may be out of date. We show the same page in every case, so
          links cannot be used to discover what exists.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/agency" className="btn-brand text-sm">
            My portal
          </Link>
          <Link href="/" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">
            Public site
          </Link>
        </div>
      </div>
    </main>
  );
}
