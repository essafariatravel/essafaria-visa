import Link from "next/link";
import type { ResolvedBranding } from "@/lib/config-service";

/** Brand mark: admin-uploaded logo when present, styled text fallback when not. */
export function SiteMark({ branding, light = false }: { branding: ResolvedBranding | null; light?: boolean }) {
  const name = branding?.brandName ?? "ESSAFARIA";
  if (branding?.logoUrl) {
    return (
      <Link href="/" className="inline-flex items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={branding.logoUrl} alt={name} className="h-9 w-auto md:h-10" />
      </Link>
    );
  }
  return (
    <Link href="/" className="inline-flex items-center gap-2">
      <span
        className="grid h-9 w-9 place-items-center rounded-lg text-base font-black text-white"
        style={{ background: light ? "rgba(255,255,255,0.16)" : "var(--color-brand-primary)" }}
      >
        E
      </span>
      <span className={`text-lg font-bold tracking-wide ${light ? "text-white" : "text-[var(--color-brand-secondary)]"}`}>
        {name}
      </span>
    </Link>
  );
}
