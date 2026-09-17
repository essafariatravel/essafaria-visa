import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  agencies,
  agencyMemberships,
  applicationStatuses,
  auditLogs,
  brandSettings,
  communicationTemplates,
  countries,
  currencies,
  documentTypes,
  homepageSections,
  legalPages,
  navItems,
  priorities,
  siteSettings,
  users,
  visaCategories,
  visaFees,
  visaRequirements,
  visaTypes,
  type Database,
} from "@/db";
import { hashPassword } from "@/lib/password";
import { env } from "@/lib/env";

/* ============================================================
 * SEED — baseline business configuration.
 *
 * Idempotent by construction: every row is inserted only if absent,
 * checked against that table's natural unique key. Re-running never
 * duplicates and never overwrites changes an admin has made.
 *
 * All business content lives HERE — and afterwards in the database,
 * editable from the Admin Control Panel — never in React code.
 * ============================================================ */

type AnyTable = any;

export interface SeedResult {
  inserted: number;
  skipped: number;
}

export async function seed(db: Database): Promise<SeedResult> {
  const result: SeedResult = { inserted: 0, skipped: 0 };

  /** Insert when no row matches the given unique column values. */
  async function ensure(table: AnyTable, values: Record<string, unknown>, uniqueCols: string[]): Promise<string> {
    const conds = uniqueCols.map((c) => eq(table[c], values[c]));
    const found = await db.select({ id: table.id }).from(table).where(and(...conds)).limit(1);
    if (found.length > 0) {
      result.skipped++;
      return found[0].id as string;
    }
    const id = (values.id as string) ?? randomUUID();
    await db.insert(table).values({ ...values, id });
    result.inserted++;
    return id;
  }

  /* ---------------- currencies ---------------- */
  for (const c of [
    { code: "EUR", name: "Euro", symbol: "€", isBase: true },
    { code: "USD", name: "US Dollar", symbol: "$", isBase: false },
    { code: "GBP", name: "Pound Sterling", symbol: "£", isBase: false },
    { code: "DZD", name: "Algerian Dinar", symbol: "DZD ", isBase: false },
    { code: "TRY", name: "Turkish Lira", symbol: "₺", isBase: false },
    { code: "MAD", name: "Moroccan Dirham", symbol: "MAD ", isBase: false },
  ]) {
    await ensure(currencies, c, ["code"]);
  }

  /* ---------------- countries ---------------- */
  const countryDefs: Array<{ code: string; name: string; region: string }> = [
    { code: "DZ", name: "Algeria", region: "North Africa" },
    { code: "MA", name: "Morocco", region: "North Africa" },
    { code: "TN", name: "Tunisia", region: "North Africa" },
    { code: "EG", name: "Egypt", region: "North Africa" },
    { code: "FR", name: "France", region: "Western Europe" },
    { code: "DE", name: "Germany", region: "Western Europe" },
    { code: "ES", name: "Spain", region: "Southern Europe" },
    { code: "IT", name: "Italy", region: "Southern Europe" },
    { code: "NL", name: "Netherlands", region: "Western Europe" },
    { code: "BE", name: "Belgium", region: "Western Europe" },
    { code: "PT", name: "Portugal", region: "Southern Europe" },
    { code: "GR", name: "Greece", region: "Southern Europe" },
    { code: "TR", name: "Türkiye", region: "Europe / Asia" },
    { code: "AE", name: "United Arab Emirates", region: "Middle East" },
    { code: "SA", name: "Saudi Arabia", region: "Middle East" },
    { code: "GB", name: "United Kingdom", region: "Northern Europe" },
    { code: "CA", name: "Canada", region: "North America" },
    { code: "US", name: "United States", region: "North America" },
    { code: "CN", name: "China", region: "East Asia" },
    { code: "JP", name: "Japan", region: "East Asia" },
  ];
  const countryIds = new Map<string, string>();
  for (const [i, c] of countryDefs.entries()) {
    countryIds.set(c.code, await ensure(countries, { ...c, displayOrder: i }, ["code"]));
  }

  /* ---------------- visa categories ---------------- */
  const categoryDefs = [
    { code: "SHORT_STAY", name: "Short Stay (Schengen Type C)", description: "Up to 90 days within 180 days" },
    { code: "LONG_STAY", name: "Long Stay (National Type D)", description: "Stay longer than 90 days" },
    { code: "WORK", name: "Work Visa", description: "Employment authorisation routes" },
    { code: "STUDY", name: "Study Visa", description: "Enrolment-based residence" },
    { code: "FAMILY", name: "Family Visit", description: "Sponsored family visits" },
    { code: "BUSINESS", name: "Business Visa", description: "Meetings, conferences, trade" },
    { code: "TRANSIT", name: "Transit Visa", description: "Passage through a country" },
    { code: "RESIDENCE", name: "Residence Permit", description: "Post-arrival residence cards" },
  ];
  const categoryIds = new Map<string, string>();
  for (const [i, c] of categoryDefs.entries()) {
    categoryIds.set(c.code, await ensure(visaCategories, { ...c, displayOrder: i }, ["code"]));
  }

  /* ---------------- document types ---------------- */
  const documentDefs = [
    { code: "PASSPORT", name: "Passport", description: "Biometric passport, valid 6+ months", allowedExtensions: ["pdf", "jpg", "png"], maxFileSizeMb: 8 },
    { code: "PHOTO", name: "ID Photo", description: "Recent biometric photo, white background", allowedExtensions: ["jpg", "png"], maxFileSizeMb: 2 },
    { code: "BANK_STATEMENT", name: "Bank Statement", description: "Last 3 months, stamped by the bank", allowedExtensions: ["pdf"], maxFileSizeMb: 10 },
    { code: "TRAVEL_INSURANCE", name: "Travel Insurance", description: "Medical cover of at least €30,000", allowedExtensions: ["pdf", "jpg", "png"], maxFileSizeMb: 5 },
    { code: "HOTEL_BOOKING", name: "Hotel Reservation", description: "Confirmed for every night of the stay", allowedExtensions: ["pdf"], maxFileSizeMb: 5 },
    { code: "FLIGHT_BOOKING", name: "Flight Reservation", description: "Round-trip reservation — ticket only after approval", allowedExtensions: ["pdf"], maxFileSizeMb: 5 },
    { code: "EMPLOYER_LETTER", name: "Employer Letter", description: "Leave approval + salary confirmation", allowedExtensions: ["pdf", "jpg"], maxFileSizeMb: 5 },
    { code: "INVITATION", name: "Invitation Letter", description: "From host family or company, certified", allowedExtensions: ["pdf", "jpg"], maxFileSizeMb: 5 },
    { code: "PROOF_OF_FUNDS", name: "Proof of Funds", description: "Sponsorship or savings evidence", allowedExtensions: ["pdf"], maxFileSizeMb: 8 },
    { code: "RESIDENCE_PROOF", name: "Proof of Residence", description: "Utility bill or residence certificate", allowedExtensions: ["pdf", "jpg"], maxFileSizeMb: 5 },
  ];
  const documentIds = new Map<string, string>();
  for (const [i, d] of documentDefs.entries()) {
    documentIds.set(
      d.code,
      await ensure(documentTypes, { ...d, displayOrder: i }, ["code"]),
    );
  }

  /* ---------------- application statuses ----------------
   * The workflow itself is DATA: each row carries the legal next states,
   * whether entering it demands a complete checklist, and whether the agency
   * may see it. Changing how files flow therefore never needs a code change. */
  const statusDefs: Array<{
    code: string;
    label: string;
    color: string;
    displayOrder: number;
    isTerminal: boolean;
    requiresDocumentsComplete?: boolean;
    customerVisible?: boolean;
    next?: string[];
  }> = [
    { code: "NEW", label: "New", color: "#2563EB", displayOrder: 10, isTerminal: false, next: ["DOCUMENTS_REQUIRED", "DOCUMENTS_RECEIVED", "CANCELLED"] },
    { code: "DOCUMENTS_REQUIRED", label: "Documents Required", color: "#D97706", displayOrder: 20, isTerminal: false, next: ["DOCUMENTS_RECEIVED", "CANCELLED"] },
    { code: "DOCUMENTS_RECEIVED", label: "Documents Received", color: "#059669", displayOrder: 30, isTerminal: false, next: ["UNDER_REVIEW", "DOCUMENTS_REQUIRED", "CANCELLED"] },
    { code: "UNDER_REVIEW", label: "Under Review", color: "#7C3AED", displayOrder: 40, isTerminal: false, next: ["READY_FOR_SUBMISSION", "DOCUMENTS_REQUIRED", "CANCELLED"] },
    { code: "READY_FOR_SUBMISSION", label: "Ready for Submission", color: "#0891B2", displayOrder: 50, isTerminal: false, next: ["SUBMITTED", "UNDER_REVIEW"] },
    { code: "SUBMITTED", label: "Submitted to Consulate", color: "#4F46E5", displayOrder: 60, isTerminal: false, requiresDocumentsComplete: true, next: ["PROCESSING", "READY_FOR_SUBMISSION", "CANCELLED"] },
    { code: "PROCESSING", label: "Processing", color: "#CA8A04", displayOrder: 70, isTerminal: false, next: ["APPROVED", "REFUSED"] },
    { code: "APPROVED", label: "Approved", color: "#16A34A", displayOrder: 80, isTerminal: false, next: ["COMPLETED", "UNDER_REVIEW"] },
    { code: "REFUSED", label: "Refused", color: "#DC2626", displayOrder: 90, isTerminal: true, next: ["UNDER_REVIEW"] },
    { code: "CANCELLED", label: "Cancelled", color: "#6B7280", displayOrder: 100, isTerminal: true, next: ["NEW"] },
    { code: "COMPLETED", label: "Completed", color: "#111827", displayOrder: 110, isTerminal: true, next: [] },
  ];
  for (const s of statusDefs) {
    const { next, requiresDocumentsComplete, customerVisible, ...rest } = s;
    await ensure(
      applicationStatuses,
      {
        ...rest,
        allowedNextStatusCodes: next ?? null,
        requiresDocumentsComplete: requiresDocumentsComplete ?? false,
        customerVisible: customerVisible ?? true,
      },
      ["code"],
    );
  }

  /* ---------------- priorities ---------------- */
  for (const p of [
    { code: "LOW", label: "Low", color: "#6B7280", surchargePercent: 0, displayOrder: 10 },
    { code: "NORMAL", label: "Normal", color: "#2563EB", surchargePercent: 0, displayOrder: 20 },
    { code: "HIGH", label: "High", color: "#D97706", surchargePercent: 15, displayOrder: 30 },
    { code: "URGENT", label: "Urgent", color: "#DC2626", surchargePercent: 35, displayOrder: 40 },
  ]) {
    await ensure(priorities, p, ["code"]);
  }

  /* ---------------- visa types + requirements + fees ---------------- */
  const visaTypeDefs = [
    { code: "FR_SCHENGEN_TOURISM", name: "France — Schengen Tourism", country: "FR", category: "SHORT_STAY", days: 15, featured: true, feeEur: 9900, serviceEur: 4500 },
    { code: "FR_SCHENGEN_BUSINESS", name: "France — Business", country: "FR", category: "BUSINESS", days: 12, featured: true, feeEur: 9900, serviceEur: 5500 },
    { code: "FR_SCHENGEN_FAMILY", name: "France — Family Visit", country: "FR", category: "FAMILY", days: 15, featured: false, feeEur: 9900, serviceEur: 4500 },
    { code: "DE_SCHENGEN_TOURISM", name: "Germany — Schengen Tourism", country: "DE", category: "SHORT_STAY", days: 14, featured: true, feeEur: 9900, serviceEur: 4500 },
    { code: "DE_WORK", name: "Germany — Work Visa", country: "DE", category: "WORK", days: 45, featured: false, feeEur: 7500, serviceEur: 9500 },
    { code: "ES_SCHENGEN_TOURISM", name: "Spain — Schengen Tourism", country: "ES", category: "SHORT_STAY", days: 15, featured: true, feeEur: 9900, serviceEur: 4500 },
    { code: "IT_SCHENGEN_TOURISM", name: "Italy — Schengen Tourism", country: "IT", category: "SHORT_STAY", days: 15, featured: false, feeEur: 9900, serviceEur: 4500 },
    { code: "NL_SCHENGEN_TOURISM", name: "Netherlands — Schengen Tourism", country: "NL", category: "SHORT_STAY", days: 18, featured: false, feeEur: 9900, serviceEur: 4500 },
    { code: "GB_STANDARD_VISITOR", name: "United Kingdom — Standard Visitor", country: "GB", category: "SHORT_STAY", days: 21, featured: true, feeEur: 12700, serviceEur: 6500 },
    { code: "US_B1_B2", name: "United States — B1/B2 Visitor", country: "US", category: "SHORT_STAY", days: 30, featured: false, feeEur: 16300, serviceEur: 8500 },
    { code: "CA_TRV", name: "Canada — Temporary Resident Visa", country: "CA", category: "SHORT_STAY", days: 30, featured: false, feeEur: 10000, serviceEur: 6000 },
    { code: "TR_E_VISA", name: "Türkiye — e-Visa", country: "TR", category: "SHORT_STAY", days: 2, featured: false, feeEur: 5200, serviceEur: 2500 },
    { code: "AE_TOURIST", name: "UAE — Tourist Visa", country: "AE", category: "SHORT_STAY", days: 4, featured: true, feeEur: 11000, serviceEur: 3500 },
    { code: "CN_L_TOURISM", name: "China — L Tourism Visa", country: "CN", category: "SHORT_STAY", days: 10, featured: false, feeEur: 8000, serviceEur: 3500 },
    { code: "FR_STUDENT", name: "France — Long Stay Student", country: "FR", category: "STUDY", days: 60, featured: false, feeEur: 5000, serviceEur: 12000 },
  ];
  const visaTypeIdByCode = new Map<string, string>();
  for (const [i, v] of visaTypeDefs.entries()) {
    const countryId = countryIds.get(v.country);
    if (!countryId) throw new Error(`seed: unknown country ${v.country}`);
    const id = await ensure(
      visaTypes,
      {
        code: v.code,
        name: v.name,
        countryId,
        categoryId: categoryIds.get(v.category) ?? null,
        description: `${v.name} — consular processing via the ESSAFARIA B2B desk.`,
        eligibilityNotes: "Applicants must demonstrate strong ties to the home country and sufficient funds.",
        processingTimeDays: v.days,
        isFeatured: v.featured,
        displayOrder: i,
      },
      ["code"],
    );
    visaTypeIdByCode.set(v.code, id);
  }

  const requirementMap: Record<string, Array<[string, boolean, string | null, number | null]>> = {
    default: [
      ["PASSPORT", true, "Valid at least 3 months beyond return date, issued within the last 10 years.", 90],
      ["PHOTO", true, "Two recent biometric photos, 35×45 mm, white background.", 60],
      ["TRAVEL_INSURANCE", true, "Minimum €30,000 medical coverage for the whole Schengen area.", 30],
      ["BANK_STATEMENT", true, "Personal statements for the last 3 months, bank-stamped.", 30],
      ["HOTEL_BOOKING", true, "Confirmed for every night of the stay.", 15],
      ["FLIGHT_BOOKING", true, "Round-trip reservation; do not ticket before approval.", 15],
      ["EMPLOYER_LETTER", false, "Required for employed applicants.", 30],
      ["PROOF_OF_FUNDS", false, "For self-sponsored applicants.", 30],
    ],
    GB_STANDARD_VISITOR: [
      ["PASSPORT", true, "Valid for the full stay.", 90],
      ["BANK_STATEMENT", true, "Six months of statements.", 30],
      ["EMPLOYER_LETTER", true, "Role, salary and approved leave.", 30],
      ["PROOF_OF_FUNDS", false, "If self-employed.", 30],
    ],
    US_B1_B2: [
      ["PASSPORT", true, "Valid 6 months beyond intended stay.", 180],
      ["PROOF_OF_FUNDS", true, "Evidence of ties and funding.", 30],
      ["INVITATION", false, "If visiting family or business partners.", 90],
    ],
    DE_WORK: [
      ["PASSPORT", true, "Valid at least 1 year.", 180],
      ["EMPLOYER_LETTER", true, "German employment contract required.", 90],
      ["PROOF_OF_FUNDS", true, "Blocked account or salary proof.", 90],
    ],
    FR_STUDENT: [
      ["PASSPORT", true, "Valid 12+ months.", 180],
      ["PROOF_OF_FUNDS", true, "≈ €615/month proof of means.", 90],
      ["RESIDENCE_PROOF", false, "Accommodation proof in France.", 60],
    ],
  };
  for (const [visaCode, visaId] of visaTypeIdByCode) {
    const defs = requirementMap[visaCode] ?? requirementMap.default!;
    let order = 0;
    for (const [docCode, required, instructions, validity] of defs) {
      const docId = documentIds.get(docCode);
      if (!docId) throw new Error(`seed: unknown document ${docCode}`);
      await ensure(
        visaRequirements,
        {
          visaTypeId: visaId,
          documentTypeId: docId,
          isRequired: required,
          instructions,
          validityDays: validity,
          displayOrder: order++,
        },
        ["visaTypeId", "documentTypeId"],
      );
    }
    const feeDef = visaTypeDefs.find((v) => v.code === visaCode)!;
    await ensure(
      visaFees,
      { visaTypeId: visaId, currencyCode: "EUR", feeType: "VISA_FEE", amountCents: feeDef.feeEur, effectiveFrom: "2026-01-01" },
      ["visaTypeId", "currencyCode", "feeType", "effectiveFrom"],
    );
    await ensure(
      visaFees,
      { visaTypeId: visaId, currencyCode: "EUR", feeType: "SERVICE_FEE", amountCents: feeDef.serviceEur, effectiveFrom: "2026-01-01" },
      ["visaTypeId", "currencyCode", "feeType", "effectiveFrom"],
    );
  }

  /* ---------------- communication templates ---------------- */
  const templateDefs = [
    {
      code: "APPLICATION_RECEIVED",
      name: "Application Received",
      subject: "Application {{application_reference}} received",
      body:
        "Dear {{client_name}},\n\nWe have received your application {{application_reference}} for {{visa_type}} " +
        "to {{country}}. Current status: {{status}}.\n\nEstimated processing time: {{processing_days}} business days.\n\n" +
        "Questions? Write to {{support_email}}.\n\n{{company_name}}",
    },
    {
      code: "MISSING_DOCUMENTS",
      name: "Missing Documents",
      subject: "Action needed for {{application_reference}}",
      body:
        "Dear {{client_name}},\n\nYour application {{application_reference}} is missing required documents. " +
        "Please upload them to keep the file moving.\n\nStatus: {{status}}.\n\n{{company_name}}",
    },
    {
      code: "DOCUMENTS_APPROVED",
      name: "Documents Approved",
      subject: "Documents approved — {{application_reference}}",
      body:
        "Dear {{client_name}},\n\nYour document set for {{visa_type}} ({{country}}) has been approved internally " +
        "and your file is ready for submission.\n\n{{company_name}}",
    },
    {
      code: "APPLICATION_SUBMITTED",
      name: "Application Submitted",
      subject: "Submitted to consulate — {{application_reference}}",
      body:
        "Dear {{client_name}},\n\nApplication {{application_reference}} for {{visa_type}} has been submitted to the " +
        "consulate. Status: {{status}}.\n\nWe will update you as soon as we hear back.\n\n{{company_name}}",
    },
    {
      code: "VISA_APPROVED",
      name: "Visa Approved",
      subject: "Visa approved — {{application_reference}}",
      body:
        "Dear {{client_name}},\n\nGreat news — the visa for {{visa_type}} ({{country}}) has been APPROVED. " +
        "Please collect your passport at {{agency_name}}.\n\n{{company_name}}",
    },
    {
      code: "VISA_REFUSED",
      name: "Visa Refused",
      subject: "Decision on {{application_reference}}",
      body:
        "Dear {{client_name}},\n\nWe regret to inform you that application {{application_reference}} has been refused. " +
        "The refusal letter is attached to your file. We are available to discuss alternatives.\n\n{{company_name}}",
    },
    {
      code: "PAYMENT_REMINDER",
      name: "Payment Reminder",
      subject: "Payment reminder — {{application_reference}}",
      body:
        "Dear {{client_name}},\n\nA payment of {{amount}} was due on {{due_date}} for application " +
        "{{application_reference}}. Kindly settle it so we can continue processing.\n\n{{company_name}}",
    },
    {
      code: "PROCESSING_UPDATE",
      name: "Processing Update",
      subject: "Update on {{application_reference}}",
      body:
        "Dear {{client_name}},\n\nStatus update for {{application_reference}} ({{visa_type}}, {{country}}): " +
        "{{status}}. Priority: {{priority}}.\n\n{{company_name}}",
    },
  ];
  for (const t of templateDefs) {
    await ensure(communicationTemplates, { ...t, language: "en" }, ["code"]);
  }

  /* ---------------- system account for automation ----------------
   * Deactivated on purpose: it cannot sign in, is never a notification
   * recipient, and exists only so scheduled writes carry a real actor id. */
  const { hashPassword } = await import("@/lib/password");
  await ensure(
    users,
    {
      email: "automation@essafaria.local",
      name: "ESSAFARIA Automation",
      passwordHash: await hashPassword(`system-${randomUUID()}`),
      role: "VISA_AGENT",
      isActive: false,
    },
    ["email"],
  );

  /* ---------------- branding ---------------- */
  const existingBrand = await db.select({ id: brandSettings.id }).from(brandSettings).limit(1);
  if (existingBrand.length === 0) {
    await db.insert(brandSettings).values({
      id: randomUUID(),
      brandName: "ESSAFARIA",
      companyName: "ESSAFARIA TRAVEL",
      tagline: "B2B visa processing, done right.",
      primaryColor: "#0E7A6D",
      secondaryColor: "#13315C",
      accentColor: "#D9A441",
      backgroundColor: "#F7F5F0",
      textColor: "#1B2430",
      buttonStyle: "rounded",
    });
    result.inserted++;
  } else result.skipped++;

  /* ---------------- site settings ---------------- */
  const settingDefs: Array<[string, string, unknown, string]> = [
    ["company.name", "GENERAL", "ESSAFARIA TRAVEL", "Company name"],
    ["company.legalName", "GENERAL", "ESSAFARIA TRAVEL SARL", "Legal name"],
    ["company.website", "GENERAL", "https://essafariavoyages.com", "Website"],
    ["contact.email", "CONTACT", "info@essafariavoyages.com", "Primary email"],
    ["contact.supportEmail", "CONTACT", "support@essafariavoyages.com", "Support email"],
    ["contact.salesEmail", "CONTACT", "sales@essafariavoyages.com", "Sales email"],
    ["contact.phone", "CONTACT", "+213 550 00 00 00", "Phone"],
    ["contact.whatsapp", "CONTACT", "+213 550 00 00 00", "WhatsApp"],
    ["contact.address", "CONTACT", "12 Rue Didouche Mourad", "Street address"],
    ["contact.city", "CONTACT", "Algiers", "City"],
    ["contact.country", "CONTACT", "Algeria", "Country"],
    ["contact.businessHours", "CONTACT", "Sun–Thu 09:00–17:00 (GMT+1)", "Business hours"],
    ["email.fromName", "EMAIL", "Essafaria Travel", "Email from-name"],
    ["visa.defaultCurrency", "VISA", "EUR", "Default currency"],
    ["visa.defaultProcessingDays", "VISA", 15, "Default processing days"],
    ["security.sessionDays", "SECURITY", 14, "Session lifetime (days)"],
    ["ops.agencySelfSubmit", "OPERATIONS", true, "Agencies may submit files themselves"],
    ["ops.requireCleanChecklistOnSubmit", "OPERATIONS", true, "Require a clean checklist to submit"],
    ["ops.perApplicantDocumentPolicy", "OPERATIONS", "ALL", "Per-applicant documents"],
    ["ops.allowLateAgencyEdits", "OPERATIONS", false, "Agencies may edit after intake"],
    ["ops.walletLowBalanceThresholdCents", "OPERATIONS", 50000, "Low wallet balance alert (cents)"],
    ["ops.allowNegativeBalance", "OPERATIONS", false, "Allow a negative wallet balance"],
    ["ops.autoChargeOnSubmit", "OPERATIONS", false, "Charge the wallet automatically on submission"],
    ["ops.documentExpiryWarningDays", "OPERATIONS", 14, "Warn before a document expires (days)"],
    ["ops.staleAfterDays", "OPERATIONS", 7, "Flag a file stale after (days)"],
    ["ops.automationEnabled", "OPERATIONS", true, "Scheduled automation enabled"],
    ["ai.enabled", "AI", true, "AI assistant enabled"],
    ["ai.autoExtraction", "AI", false, "Run extraction automatically on upload"],
    ["ai.summaryLanguage", "AI", "en", "Summary language"],
    ["ai.minConfidencePercent", "AI", 80, "Confidence below this always needs a human"],
    ["gmail.enabled", "GMAIL", false, "Gmail intake enabled"],
    ["gmail.autoAttachDocuments", "GMAIL", true, "Stage inbound attachments for review"],
    [
      "gmail.inboundRules",
      "GMAIL",
      [
        { classification: "PAYMENT", keywords: ["invoice", "payment received", "bank transfer", "proof of payment", "receipt"] },
        { classification: "SPAM", keywords: ["unsubscribe", "newsletter", "promotion", "webinar"] },
        {
          classification: "APPLICATION_UPDATE",
          keywords: ["document", "passport", "appointment", "biometric", "missing", "refused", "approved"],
        },
        { classification: "NEW_REQUEST", keywords: ["new application", "request for", "quote", "pricing"] },
      ],
      "Inbound classification rules",
    ],
    ["gmail.referencePattern", "GMAIL", "ESF-\\d{4}-\\d{6}", "Application reference pattern"],
    ["notifications.enabled", "NOTIFICATIONS", "true", "Email notifications"],
  ];
  for (const [key, category, value, label] of settingDefs) {
    if (value === null || value === undefined) continue; // unset until configured in admin
    const existing = await db.select({ id: siteSettings.id }).from(siteSettings).where(eq(siteSettings.key, key)).limit(1);
    if (existing.length === 0) {
      await db.insert(siteSettings).values({ id: randomUUID(), key, category, value, label });
      result.inserted++;
    } else result.skipped++;
  }

  /* ---------------- navigation ---------------- */
  for (const n of [
    { location: "HEADER", label: "Home", href: "/", displayOrder: 10, isSystem: true },
    { location: "HEADER", label: "Visa Services", href: "/visas", displayOrder: 20, isSystem: false },
    { location: "HEADER", label: "Agency Portal", href: "/login", displayOrder: 40, isSystem: false },
    { location: "FOOTER", label: "Privacy Policy", href: "/legal/privacy-policy", displayOrder: 10, isSystem: true },
    { location: "FOOTER", label: "Terms & Conditions", href: "/legal/terms-and-conditions", displayOrder: 20, isSystem: true },
    { location: "FOOTER", label: "Contact", href: "/contact", displayOrder: 40, isSystem: false },
  ] as const) {
    await ensure(navItems, n, ["location", "label"]);
  }

  /* ---------------- homepage sections (CMS) ---------------- */
  const now = new Date();
  const sectionDefs = [
    {
      sectionType: "hero",
      title: "Visa processing for serious travel agencies",
      subtitle: "Schengen, UK, US and Gulf files — prepared, verified, tracked.",
      body:
        "ESSAFARIA VISA OS is the B2B operations layer for visa processing: agency accounts, per-country " +
        "requirements, document verification and consular status tracking in one place.",
      ctaLabel: "Become a partner agency",
      ctaHref: "/contact",
      overlayOpacity: 45,
      displayOrder: 10,
      config: {},
    },
    {
      sectionType: "services",
      title: "What we handle",
      subtitle: "Built for agency workflows, not checklists.",
      displayOrder: 20,
      config: {
        items: [
          { title: "Schengen short stay", description: "Tourism, business and family files for all Schengen states." },
          { title: "UK & US visitor visas", description: "DS-160, appointment booking and interview preparation." },
          { title: "Gulf e-visas", description: "UAE, Saudi and Qatar with fast-track options." },
          { title: "Long stay & work", description: "National visas, residence permits, family reunification." },
        ],
      },
    },
    {
      sectionType: "destinations",
      title: "Popular destinations",
      subtitle: "Configured live from the visa catalog — add a country in admin, watch it appear here.",
      displayOrder: 30,
      config: { countryCodes: ["FR", "DE", "ES", "GB", "AE", "US", "TR", "IT"] },
    },
    {
      sectionType: "process",
      title: "How an ESSAFARIA file moves",
      displayOrder: 40,
      config: {
        items: [
          { title: "Request", description: "Agency opens a visa request with applicant data." },
          { title: "Documents", description: "Applicants upload files against the checklist." },
          { title: "Verification", description: "Our desk verifies every document, twice." },
          { title: "Submission", description: "Consulate submission and fee payment handled." },
          { title: "Status", description: "Live status from receipt to passport return." },
        ],
      },
    },
    {
      sectionType: "why",
      title: "Why agencies choose Essafaria",
      displayOrder: 50,
      config: {
        items: [
          { title: "Requirements you control", description: "Per-visa document rules configured in admin, enforced at upload." },
          { title: "Audit everything", description: "Every configuration change is logged and reversible." },
          { title: "B2B pricing", description: "Service fees per visa type and currency, effective-dated." },
        ],
      },
    },
    {
      sectionType: "cta",
      title: "Ready to route your visa files through one desk?",
      body: "Create an agency account and process your first file today.",
      ctaLabel: "Talk to our B2B desk",
      ctaHref: "/contact",
      displayOrder: 60,
      config: {},
    },
  ];
  for (const s of sectionDefs) {
    await ensure(
      homepageSections,
      { ...s, isActive: true, publishState: "PUBLISHED", publishedAt: now },
      ["sectionType", "displayOrder"],
    );
  }

  /* ---------------- legal pages ---------------- */
  const legalDefs = [
    {
      slug: "privacy-policy",
      title: "Privacy Policy",
      body: [
        { type: "h2", text: "Data we process" },
        { type: "p", text: "ESSAFARIA TRAVEL processes applicant and agency data strictly for visa processing purposes: identity documents, travel history and payment records." },
        { type: "h2", text: "Retention" },
        { type: "p", text: "Application records are retained as required by consular jurisdictions and applicable commercial law." },
      ],
    },
    {
      slug: "terms-and-conditions",
      title: "Terms & Conditions",
      body: [
        { type: "h2", text: "Service scope" },
        { type: "p", text: "ESSAFARIA acts as an authorised filing agent. Visa decisions are the exclusive competence of consular authorities." },
        { type: "h2", text: "No guarantee" },
        { type: "p", text: "Professional preparation does not constitute a guarantee of approval. Government fees are non-refundable once submitted." },
      ],
    },
    {
      slug: "visa-terms",
      title: "Visa Service Terms",
      body: [
        { type: "h2", text: "Applicant obligations" },
        { type: "li", text: "Provide complete and truthful documents." },
        { type: "li", text: "Attend biometrics appointments on time." },
        { type: "li", text: "Report travel-plan changes before submission." },
      ],
    },
    {
      slug: "b2b-terms",
      title: "Agency (B2B) Terms",
      body: [
        { type: "h2", text: "Agency responsibilities" },
        { type: "p", text: "Registered agencies must verify documents received from their own clients before transmitting files to ESSAFARIA." },
        { type: "h2", text: "Pricing" },
        { type: "p", text: "Service fees follow the configured price list in the agency portal and may be revised with 30 days' notice." },
      ],
    },
  ];
  for (const p of legalDefs) {
    await ensure(legalPages, { ...p, publishState: "PUBLISHED", publishedAt: now }, ["slug"]);
  }

  /* ---------------- agencies & users ---------------- */
  const adminPass = env().SEED_ADMIN_PASSWORD ?? "change-me-strong-admin-password";
  const agencyPass = env().SEED_AGENCY_PASSWORD ?? adminPass;

  const agencyIds: string[] = [];
  for (const a of [
    {
      code: "ESSAF001",
      name: "Essafaria Travel (HQ)",
      legalName: "ESSAFARIA TRAVEL SARL",
      email: "info@essafariavoyages.com",
      phone: "+213 550 00 00 00",
      city: "Algiers",
      address: "12 Rue Didouche Mourad",
      contactPerson: "Operations Desk",
      status: "ACTIVE",
      countryId: countryIds.get("DZ") ?? null,
    },
    {
      code: "SAH002",
      name: "Sahara Voyages Oran",
      legalName: "Sahara Voyages EURL",
      email: "contact@saharavoyages.dz",
      phone: "+213 41 00 00 00",
      city: "Oran",
      contactPerson: "Karim Belkacem",
      status: "ACTIVE",
      countryId: countryIds.get("DZ") ?? null,
    },
  ]) {
    agencyIds.push(await ensure(agencies, a, ["code"]));
  }

  const [staffHash, agencyHash] = await Promise.all([
    hashPassword(adminPass),
    hashPassword(agencyPass),
  ]);

  const userDefs = [
    { email: "admin@essafaria.local", name: "Platform Administrator", role: "SUPER_ADMIN", hash: staffHash, agency: -1 },
    { email: "ops@essafaria.local", name: "Visa Operations Desk", role: "VISA_AGENT", hash: staffHash, agency: -1 },
    { email: "finance@essafaria.local", name: "Finance Office", role: "ACCOUNTING", hash: staffHash, agency: -1 },
    { email: "owner@saharavoyages.dz", name: "Sahara Owner", role: "AGENCY_ADMIN", hash: agencyHash, agency: 1 },
    { email: "agent@saharavoyages.dz", name: "Sahara Agent", role: "AGENCY_USER", hash: agencyHash, agency: 1 },
  ] as const;
  for (const u of userDefs) {
    const userId = await ensure(users, { email: u.email, name: u.name, role: u.role, passwordHash: u.hash, isActive: true }, ["email"]);
    if (u.agency >= 0) {
      await db
        .insert(agencyMemberships)
        .values({ agencyId: agencyIds[u.agency]!, userId, isPrimary: u.role === "AGENCY_ADMIN" })
        .onConflictDoNothing();
    }
  }

  /* seed provenance entry in audit log (first time only) */
  const existingAudit = await db.select({ id: auditLogs.id }).from(auditLogs).limit(1);
  if (existingAudit.length === 0) {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      action: "CREATE",
      entityType: "system",
      entityId: "seed",
      metadata: { note: "Baseline configuration seeded" },
    });
  }

  return result;
}
