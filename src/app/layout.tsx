import type { Metadata } from "next";
import { getBranding } from "@/lib/config-service";
import "./globals.css";

export const dynamic = "force-dynamic"; // branding must always reflect admin changes

async function brandMeta(): Promise<{ title: string; icon: string | undefined; cssVars: React.CSSProperties }> {
  try {
    const b = await getBranding();
    return {
      title: `${b.brandName} — Visa OS`,
      icon: b.faviconUrl ?? undefined,
      cssVars: {
        "--color-brand-primary": b.primaryColor,
        "--color-brand-secondary": b.secondaryColor,
        "--color-brand-accent": b.accentColor,
        "--color-brand-background": b.backgroundColor,
        "--color-brand-text": b.textColor,
        "--brand-radius": b.buttonStyle === "pill" ? "999px" : b.buttonStyle === "square" ? "0px" : "0.5rem",
      } as React.CSSProperties,
    };
  } catch (err) {
    // Missing configuration must not crash the shell (spec §32): fall back,
    // but report loudly.
    console.error("[layout] branding unavailable, using fallbacks:", err);
    return { title: "ESSAFARIA — Visa OS", icon: undefined, cssVars: {} as React.CSSProperties };
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const { title, icon } = await brandMeta();
  return { title, icons: icon ? { icon } : undefined };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { cssVars } = await brandMeta();
  return (
    <html lang="en">
      <body style={cssVars} className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
