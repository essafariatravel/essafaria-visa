import { and, asc, eq } from "drizzle-orm";
import {
  getDb,
  brandSettings,
  siteSettings,
  navItems,
  homepageSections,
  countries,
  visaCategories,
  visaTypes,
  documentTypes,
  applicationStatuses,
  priorities,
  currencies,
  visaFees,
  media,
} from "@/db";
import type { BrandSettings, SiteSetting } from "@/db/schema";

/* ============================================================
 * Configuration service — the single read path for business/site
 * configuration used by front office, agency portal and admin.
 *
 * Caching strategy (per spec §33):
 *   - small in-memory TTL cache (60 s) so hot pages do not re-query
 *     configuration on every render;
 *   - explicit invalidation from every admin mutation, so a change
 *     is visible immediately in the same process;
 *   - a version counter lets callers force-bypass stale reads.
 * Deliberately simple: correct invalidation beats a clever cache.
 * ============================================================ */

const TTL_MS = 60_000;

const cache = new Map<string, { value: unknown; at: number }>();
let version = 0;

function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value as T);
  return loader().then((value) => {
    cache.set(key, { value, at: Date.now() });
    return value;
  });
}

/** Invalidate after configuration writes. Call from every mutating service. */
export function invalidateConfig(prefix?: string): void {
  version++;
  if (!prefix) cache.clear();
  else for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

export function configVersion(): number {
  return version;
}

/* ---------------- branding ---------------- */

/** Safe fallback used when branding rows are missing — logged, never silent. */
export const DEFAULT_BRANDING: Omit<BrandSettings, "id" | "createdAt" | "updatedAt"> = {
  brandName: "ESSAFARIA",
  companyName: "ESSAFARIA TRAVEL",
  tagline: null,
  primaryColor: "#0E7A6D",
  secondaryColor: "#13315C",
  accentColor: "#D9A441",
  backgroundColor: "#F7F5F0",
  textColor: "#1B2430",
  logoMediaId: null,
  secondaryLogoMediaId: null,
  faviconMediaId: null,
  buttonStyle: "rounded",
};

export type ResolvedBranding = typeof DEFAULT_BRANDING & {
  logoUrl: string | null;
  faviconUrl: string | null;
};

export function getBranding(): Promise<ResolvedBranding> {
  return cached("branding", async () => {
    const db = await getDb();
    const [row] = await db.select().from(brandSettings).limit(1);
    if (!row) {
      console.warn("[config] brand_settings is empty — using defaults");
      return { ...DEFAULT_BRANDING, logoUrl: null, faviconUrl: null };
    }
    const urls = new Map<string, string>();
    const wanted = [row.logoMediaId, row.faviconMediaId].filter(Boolean) as string[];
    if (wanted.length) {
      for (const id of wanted) urls.set(id, `/api/media/${id}`);
    }
    return {
      ...DEFAULT_BRANDING,
      ...row,
      logoUrl: row.logoMediaId ? urls.get(row.logoMediaId) ?? null : null,
      faviconUrl: row.faviconMediaId ? urls.get(row.faviconMediaId) ?? null : null,
    };
  });
}

/* ---------------- site settings ---------------- */

/**
 * Read a setting through an EXPLICIT query handle.
 *
 * Inside an open transaction this is mandatory: the embedded driver serialises
 * a single connection, and on real PostgreSQL a second connection would read
 * (and, worse, be able to write) OUTSIDE the transaction, silently breaking
 * atomicity. Every service therefore passes its `tx` here.
 */
export async function getSettingIn<T = unknown>(handle: unknown, key: string, fallback: T): Promise<T> {
  const t = handle as any;
  const rows = (await t.select().from(siteSettings).where(eq(siteSettings.key, key)).limit(1)) as Array<
    SiteSetting
  >;
  const row = rows[0];
  if (!row) return fallback;
  return row.value as T;
}

export async function getSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  return getSettingIn(db, key, fallback);
}

export function getContact(): Promise<Record<string, unknown>> {
  return cached("settings:contact", async () => {
    const db = await getDb();
    const rows = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.category, "CONTACT"));
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  });
}

/* ---------------- navigation ---------------- */

export function getNavItems(location: "HEADER" | "FOOTER") {
  return cached(`nav:${location}`, async () => {
    const db = await getDb();
    return db
      .select()
      .from(navItems)
      .where(eq(navItems.location, location))
      .orderBy(asc(navItems.displayOrder));
  });
}

/* ---------------- homepage (public reads only PUBLISHED) ---------------- */

export interface HomepageSectionView {
  id: string;
  sectionType: string;
  title: string | null;
  subtitle: string | null;
  body: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  overlayOpacity: number | null;
  config: Record<string, unknown>;
  displayOrder: number;
}

export function getPublishedHomepageSections(): Promise<HomepageSectionView[]> {
  return cached("homepage:published", async () => {
    const db = await getDb();
    const rows = await db
      .select({
        s: homepageSections,
        mediaKey: media.id,
      })
      .from(homepageSections)
      .leftJoin(media, eq(homepageSections.imageMediaId, media.id))
      .where(eq(homepageSections.publishState, "PUBLISHED"))
      .orderBy(asc(homepageSections.displayOrder));
    return rows
      .filter((r) => r.s.isActive)
      .map((r) => ({
        id: r.s.id,
        sectionType: r.s.sectionType,
        title: r.s.title,
        subtitle: r.s.subtitle,
        body: r.s.body,
        ctaLabel: r.s.ctaLabel,
        ctaHref: r.s.ctaHref,
        imageUrl: r.mediaKey ? `/api/media/${r.mediaKey}` : null,
        overlayOpacity: r.s.overlayOpacity,
        config: (r.s.config ?? {}) as Record<string, unknown>,
        displayOrder: r.s.displayOrder,
      }));
  });
}

/* ---------------- visa catalog (public/agency) ---------------- */

export interface PublicCountry {
  code: string;
  name: string;
  region: string | null;
}

export function getActiveCountries(): Promise<PublicCountry[]> {
  return cached("countries:active", async () => {
    const db = await getDb();
    const rows = await db
      .select({ code: countries.code, name: countries.name, region: countries.region })
      .from(countries)
      .where(eq(countries.isActive, true))
      .orderBy(asc(countries.displayOrder), asc(countries.name));
    return rows;
  });
}

export type VisaCatalogRow = Awaited<ReturnType<typeof getVisaCatalog>>[number];

export function getVisaCatalog(opts: { featuredOnly?: boolean; countryCode?: string } = {}) {
  return cached(`visa-catalog:${opts.featuredOnly ? "f" : "a"}:${opts.countryCode ?? "*"}`, async () => {
    const db = await getDb();
    const base = await db
      .select({
        id: visaTypes.id,
        code: visaTypes.code,
        name: visaTypes.name,
        description: visaTypes.description,
        eligibilityNotes: visaTypes.eligibilityNotes,
        processingTimeDays: visaTypes.processingTimeDays,
        isFeatured: visaTypes.isFeatured,
        countryName: countries.name,
        countryCode: countries.code,
        categoryName: visaCategories.name,
      })
      .from(visaTypes)
      .innerJoin(countries, eq(countries.id, visaTypes.countryId))
      .leftJoin(visaCategories, eq(visaCategories.id, visaTypes.categoryId))
      .where(eq(visaTypes.isActive, true))
      .orderBy(asc(visaTypes.displayOrder), asc(visaTypes.name));
    return base.filter((v) => {
      if (opts.featuredOnly && !v.isFeatured) return false;
      if (opts.countryCode && v.countryCode.toUpperCase() !== opts.countryCode.toUpperCase()) return false;
      return true;
    });
  });
}

export async function getActiveDocumentTypes() {
  const db = await getDb();
  return db
    .select()
    .from(documentTypes)
    .where(eq(documentTypes.isActive, true))
    .orderBy(asc(documentTypes.displayOrder), asc(documentTypes.name));
}

export async function getActiveStatuses() {
  const db = await getDb();
  return db
    .select()
    .from(applicationStatuses)
    .where(eq(applicationStatuses.isActive, true))
    .orderBy(asc(applicationStatuses.displayOrder));
}

export async function getActivePriorities() {
  const db = await getDb();
  return db
    .select()
    .from(priorities)
    .where(eq(priorities.isActive, true))
    .orderBy(asc(priorities.displayOrder));
}

export async function getCurrencies() {
  const db = await getDb();
  return db.select().from(currencies).where(eq(currencies.isActive, true)).orderBy(asc(currencies.code));
}

export async function getVisaTypeDetail(id: string) {
  const db = await getDb();
  const [t] = await db
    .select({
      id: visaTypes.id,
      code: visaTypes.code,
      name: visaTypes.name,
      description: visaTypes.description,
      eligibilityNotes: visaTypes.eligibilityNotes,
      processingTimeDays: visaTypes.processingTimeDays,
      countryName: countries.name,
      countryCode: countries.code,
      categoryName: visaCategories.name,
    })
    .from(visaTypes)
    .innerJoin(countries, eq(countries.id, visaTypes.countryId))
    .leftJoin(visaCategories, eq(visaCategories.id, visaTypes.categoryId))
    .where(eq(visaTypes.id, id))
    .limit(1);
  if (!t) return null;
  const { visaRequirements } = await import("@/db");
  const reqs = await db
    .select({
      id: visaRequirements.id,
      isRequired: visaRequirements.isRequired,
      instructions: visaRequirements.instructions,
      validityDays: visaRequirements.validityDays,
      documentName: documentTypes.name,
      documentCode: documentTypes.code,
      allowedExtensions: documentTypes.allowedExtensions,
      maxFileSizeMb: documentTypes.maxFileSizeMb,
    })
    .from(visaRequirements)
    .innerJoin(documentTypes, eq(documentTypes.id, visaRequirements.documentTypeId))
    .where(eq(visaRequirements.visaTypeId, id))
    .orderBy(asc(visaRequirements.displayOrder));
  const fees = await db
    .select({
      feeType: visaFees.feeType,
      amountCents: visaFees.amountCents,
      currencyCode: visaFees.currencyCode,
      effectiveFrom: visaFees.effectiveFrom,
      notes: visaFees.notes,
    })
    .from(visaFees)
    .where(and(eq(visaFees.visaTypeId, id), eq(visaFees.isActive, true)));
  return { ...t, requirements: reqs, fees };
}

export function formatMoney(cents: number, code: string): string {
  const symbols: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", TRY: "₺", DZD: "DZD ", MAD: "MAD " };
  const value = (cents / 100).toFixed(2);
  const sym = symbols[code] ?? `${code} `;
  return code === "EUR" || code === "USD" || code === "GBP" || code === "TRY"
    ? `${sym}${value}`
    : `${value} ${code}`;
}
