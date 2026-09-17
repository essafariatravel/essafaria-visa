import { z } from "zod";

/* ============================================================
 * Shared validation primitives.
 * Every admin/API input path runs through these — the UI is never
 * the only gate. Config values are validated structurally, not
 * trusted. Empty form strings are normalized to null.
 * ============================================================ */

/** Optional text field: "" → null, trimmed, bounded. */
/** `null` is normalised like "" so a value that has already been through this
 *  schema can be validated again without inventing the string "NULL". */
const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export const optionalText = (max = 4000) =>
  z.preprocess(
    (v) => (isEmpty(v) ? null : typeof v === "string" ? v.trim() : v),
    z.string().max(max).nullable(),
  );

export const requiredText = (max = 500, min = 1) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(min).max(max));

export const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color like #0E7A6D");

/** Safe href: internal paths, anchors, http(s), mailto:, tel:. Rejects javascript:/data:/protocol-relative URLs. */
export const safeHref = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((v) => {
    if (/^(javascript|data|vbscript):/i.test(v)) return false;
    if (v.startsWith("//")) return false;
    if (v.startsWith("/") || v.startsWith("#")) return true;
    if (/^(https?:|mailto:|tel:)/i.test(v)) return true;
    return !v.includes(":") && /^[a-z0-9\-._~%/]+$/i.test(v);
  }, "Must be an internal path/anchor or a safe http(s)/mailto/tel URL");

/** URL that is "" → null, otherwise must be http(s). */
export const optionalUrl = z.preprocess(
  (v) => (isEmpty(v) ? null : v),
  z.string().url().startsWith("http").max(2048).nullable(),
);

export const optionalEmail = z.preprocess(
  (v) => (isEmpty(v) ? null : v),
  z.string().trim().toLowerCase().email().max(254).nullable(),
);

export const emailField = z.string().trim().toLowerCase().email().max(254);

export const phoneField = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()\-.]{6,32}$/, "Enter a valid phone number");

export const optionalPhone = z.preprocess(
  (v) => (isEmpty(v) ? null : v),
  phoneField.nullable(),
);

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, "Lowercase letters, digits and dashes");

export const entityCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,29}$/, "Code: A–Z/digits/underscore, 2–30 chars, must start with a letter");

export const agencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9-]{1,24}$/, "Agency code: A–Z, digits, dashes, 2–25 chars");

export const isoCountryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2,3}$/, "Use an ISO country code, e.g. FR or UAE");

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "ISO-4217 code, e.g. EUR");

export const moneyCents = z.coerce.number().int("Whole cents only").min(0).max(1_000_000_000);
export const percentage = z.coerce.number().int().min(0).max(500);
export const displayOrder = z.coerce.number().int().min(0).max(99_999).default(0);
export const boolField = z.preprocess((v) => v === "on" || v === true || v === "true", z.boolean());

export const fileExtensionList = z
  .array(z.string().trim().toLowerCase().regex(/^[a-z0-9]{1,8}$/))
  .max(12)
  .default([]);

export const idRef = requiredText(64, 1);

/** Optional reference field ("" → null). */
export const optionalIdRef = z.preprocess(
  (v) => (isEmpty(v) ? null : v),
  z.string().trim().min(1).max(64).nullable(),
);

export const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/* ---------------- template variables (whitelist, no arbitrary execution) ---------------- */

export const TEMPLATE_VARIABLES = [
  "agency_name",
  "client_name",
  "application_reference",
  "visa_type",
  "country",
  "status",
  "priority",
  "amount",
  "due_date",
  "processing_days",
  "support_email",
  "company_name",
] as const;

const PLACEHOLDER_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g;
const ANY_CURLY_RE = /\{\{[^{}]*\}\}/g;

function placeholdersAreWhitelisted(text: string): boolean {
  const valid = [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[0]);
  const all = [...text.matchAll(ANY_CURLY_RE)].map((m) => m[0]);
  if (all.length !== valid.length) return false;
  return valid.every((token) => {
    const key = /\{\{\s*([a-z0-9_]+)\s*\}\}/.exec(token)?.[1] ?? "";
    return (TEMPLATE_VARIABLES as readonly string[]).includes(key);
  });
}

export const templateField = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(placeholdersAreWhitelisted, {
      message: `Unknown or malformed {{placeholder}} — allowed: ${TEMPLATE_VARIABLES.join(", ")}`,
    });

/** Render a stored template with known variables only. Values are escaped; no HTML execution. */
export function renderTemplate(
  text: string,
  vars: Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string>>,
): string {
  return text.replace(PLACEHOLDER_RE, (token, key: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(key)) return token;
    const value = vars[key as (typeof TEMPLATE_VARIABLES)[number]];
    return value !== undefined ? escapeHtml(value) : token;
  });
}

export function escapeHtml(v: string): string {
  return v.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/* ---------------- entity-level admin schemas ---------------- */

export const agencyUpsertSchema = z.object({
  code: agencyCode,
  name: requiredText(160),
  legalName: optionalText(200),
  email: optionalEmail,
  phone: optionalPhone,
  city: optionalText(120),
  address: optionalText(400),
  contactPerson: optionalText(160),
  billingInfo: optionalText(2000),
  notes: optionalText(2000),
  status: z.enum(["ACTIVE", "SUSPENDED", "INACTIVE"]).default("ACTIVE"),
  countryId: optionalIdRef,
});

export const countryUpsertSchema = z.object({
  code: isoCountryCode,
  name: requiredText(120),
  region: optionalText(120),
  isActive: boolField,
  displayOrder,
});

export const visaCategoryUpsertSchema = z.object({
  code: entityCode,
  name: requiredText(120),
  description: optionalText(600),
  isActive: boolField,
  displayOrder,
});

export const visaTypeUpsertSchema = z.object({
  code: entityCode,
  name: requiredText(160),
  countryId: idRef,
  categoryId: optionalIdRef,
  description: optionalText(2000),
  eligibilityNotes: optionalText(2000),
  processingTimeDays: z.preprocess(
    (v) => (isEmpty(v) ? null : v),
    z.coerce.number().int().min(1).max(365).nullable(),
  ),
  isActive: boolField,
  isFeatured: boolField,
  displayOrder,
});

export const requirementUpsertSchema = z.object({
  // carried through so an admin can ADD a requirement from the visa-type screen;
  // optional here because an edit does not need to resubmit it
  visaTypeId: optionalIdRef,
  documentTypeId: idRef,
  isRequired: boolField,
  instructions: optionalText(1000),
  validityDays: z.preprocess(
    (v) => (isEmpty(v) ? null : v),
    z.coerce.number().int().min(1).max(3650).nullable(),
  ),
  displayOrder,
});

export const documentTypeUpsertSchema = z.object({
  code: entityCode,
  name: requiredText(120),
  description: optionalText(600),
  allowedExtensions: fileExtensionList,
  maxFileSizeMb: z.preprocess(
    (v) => (isEmpty(v) ? null : v),
    z.coerce.number().int().min(1).max(100).nullable(),
  ),
  isActive: boolField,
  displayOrder,
});

/** Comma-separated list of status codes; empty string → null ("anything may
 *  follow"), explicit "NONE" → [] ("no exits"). Validated against the status
 *  vocabulary by the CRUD transform, so a typo can't disable a transition. */
const statusCodesList = z.preprocess((v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return v;
  const parts = v.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  return parts.length ? parts : null;
}, z.array(entityCode).nullable());

export const statusUpsertSchema = z.object({
  code: entityCode,
  label: requiredText(80),
  color: hexColor,
  description: optionalText(400),
  isTerminal: boolField,
  isActive: boolField,
  displayOrder,
  requiresDocumentsComplete: boolField,
  customerVisible: boolField,
  allowedNextStatusCodes: statusCodesList,
});

export const priorityUpsertSchema = z.object({
  code: entityCode,
  label: requiredText(80),
  color: hexColor,
  surchargePercent: percentage,
  isActive: boolField,
  displayOrder,
});

export const currencyUpsertSchema = z.object({
  code: currencyCode,
  name: requiredText(80),
  symbol: requiredText(8),
  isBase: boolField,
  isActive: boolField,
});

export const feeUpsertSchema = z.object({
  visaTypeId: idRef,
  currencyCode: currencyCode,
  feeType: z.enum(["VISA_FEE", "SERVICE_FEE", "B2B_PRICE"]),
  amountCents: moneyCents,
  effectiveFrom: isoDate,
  isActive: boolField,
  notes: optionalText(600),
});

export const templateUpsertSchema = z.object({
  code: entityCode,
  name: requiredText(120),
  subject: templateField(200),
  body: templateField(8000),
  language: z.preprocess(
    (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : "en"),
    z.string().regex(/^[a-z]{2}(-[a-z]{2})?$/),
  ),
  description: optionalText(400),
  isActive: boolField,
});

export const brandingUpdateSchema = z.object({
  brandName: requiredText(80),
  companyName: requiredText(160),
  tagline: optionalText(240),
  primaryColor: hexColor,
  secondaryColor: hexColor,
  accentColor: hexColor,
  backgroundColor: hexColor,
  textColor: hexColor,
  buttonStyle: z.enum(["rounded", "pill", "square"]).default("rounded"),
  logoMediaId: optionalIdRef,
  secondaryLogoMediaId: optionalIdRef,
  faviconMediaId: optionalIdRef,
});

export const navItemUpsertSchema = z.object({
  location: z.enum(["HEADER", "FOOTER"]),
  label: requiredText(60),
  href: safeHref,
  displayOrder,
  isActive: boolField,
});

/** Homepage sections: structured content, bounded sizes, no raw HTML. */
export const sectionItemSchema = z.object({
  title: requiredText(120),
  description: z.preprocess((v) => (typeof v === "string" ? v.trim() : ""), z.string().max(500)),
});

export const homepageSectionUpsertSchema = z.object({
  sectionType: z.enum(["hero", "services", "destinations", "process", "why", "cta"]),
  title: optionalText(200),
  subtitle: optionalText(300),
  body: optionalText(3000),
  ctaLabel: optionalText(60),
  ctaHref: z.preprocess(
    (v) => (isEmpty(v) ? null : v),
    safeHref.nullable(),
  ),
  imageMediaId: optionalIdRef,
  overlayOpacity: z.preprocess(
    (v) => (isEmpty(v) ? null : v),
    z.coerce.number().int().min(0).max(100).nullable(),
  ),
  items: z.array(sectionItemSchema).max(12),
  isActive: boolField,
  displayOrder,
});

export const legalPageUpsertSchema = z.object({
  slug,
  title: requiredText(160),
  body: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("h2"), text: requiredText(200) }),
        z.object({ type: z.literal("p"), text: z.string().trim().min(1).max(4000) }),
        z.object({ type: z.literal("li"), text: requiredText(600) }),
      ]),
    )
    .max(120),
  publishState: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).default("DRAFT"),
});

/** Typed site settings registry — no unbounded free-form config. */
const boolSetting = z.enum(["true", "false"]).transform((v) => v === "true");
const intSetting = (max: number) => z.coerce.number().int().min(0).max(max);

/**
 * Operational workflow settings. These exist so the *business* rules of the
 * platform — who may submit, whether a clean checklist is required, how money
 * may move — are editable from the Back Office instead of being buried in
 * code. Each key is validated by its schema before it is stored.
 */
export const SETTING_DEFINITIONS: Record<string, { label: string; category: string; schema: z.ZodType; description?: string }> = {
  "company.name": { label: "Company name", category: "GENERAL", schema: requiredText(160) },
  "company.legalName": { label: "Legal name", category: "GENERAL", schema: optionalText(200) },
  "company.website": { label: "Website", category: "GENERAL", schema: optionalUrl },
  "contact.email": { label: "Primary email", category: "CONTACT", schema: emailField },
  "contact.supportEmail": { label: "Support email", category: "CONTACT", schema: emailField },
  "contact.salesEmail": { label: "Sales email", category: "CONTACT", schema: emailField },
  "contact.phone": { label: "Phone", category: "CONTACT", schema: phoneField },
  "contact.whatsapp": { label: "WhatsApp", category: "CONTACT", schema: phoneField },
  "contact.address": { label: "Street address", category: "CONTACT", schema: requiredText(300) },
  "contact.city": { label: "City", category: "CONTACT", schema: requiredText(120) },
  "contact.country": { label: "Country", category: "CONTACT", schema: requiredText(120) },
  "contact.businessHours": { label: "Business hours", category: "CONTACT", schema: requiredText(200) },
  "social.facebook": { label: "Facebook URL", category: "SOCIAL", schema: optionalUrl },
  "social.instagram": { label: "Instagram URL", category: "SOCIAL", schema: optionalUrl },
  "social.linkedin": { label: "LinkedIn URL", category: "SOCIAL", schema: optionalUrl },
  "email.fromName": { label: "Email from-name", category: "EMAIL", schema: requiredText(120) },
  "visa.defaultCurrency": { label: "Default currency", category: "VISA", schema: currencyCode },
  "visa.defaultProcessingDays": {
    label: "Default processing time (business days)",
    category: "VISA",
    schema: z.coerce.number().int().min(1).max(365),
  },
  "security.sessionDays": {
    label: "Session lifetime (days)",
    category: "SECURITY",
    schema: z.coerce.number().int().min(1).max(90),
  },
  "notifications.enabled": {
    label: "Email notifications enabled",
    category: "NOTIFICATIONS",
    schema: boolSetting,
  },
  /* ---- workflow & gates (Phase 3+) ---- */
  "ops.agencySelfSubmit": {
    label: "Agencies may submit files themselves",
    category: "OPERATIONS",
    schema: boolSetting,
    description: "When off, only the ESSAFARIA desk can move a file past a gated status",
  },
  "ops.requireCleanChecklistOnSubmit": {
    label: "Require a clean checklist to submit",
    category: "OPERATIONS",
    schema: boolSetting,
    description: "Per-status enforcement is configured on the status itself",
  },
  "ops.perApplicantDocumentPolicy": {
    label: "Per-applicant documents",
    category: "OPERATIONS",
    schema: z.enum(["ALL", "ANY"]),
    description: "ALL: every applicant must hold the document. ANY: one upload covers the group",
  },
  "ops.allowLateAgencyEdits": {
    label: "Agencies may edit after intake",
    category: "OPERATIONS",
    schema: boolSetting,
  },
  /* ---- money (Phase 7) ---- */
  "ops.walletLowBalanceThresholdCents": {
    label: "Low wallet balance alert (cents)",
    category: "OPERATIONS",
    schema: intSetting(1_000_000_000_000),
  },
  "ops.allowNegativeBalance": {
    label: "Allow a negative wallet balance",
    category: "OPERATIONS",
    schema: boolSetting,
    description: "Off by default: a file cannot be charged without funds",
  },
  "ops.autoChargeOnSubmit": {
    label: "Charge the wallet automatically on submission",
    category: "OPERATIONS",
    schema: boolSetting,
  },
  /* ---- automation (Phase 10) ---- */
  "ops.documentExpiryWarningDays": {
    label: "Warn before a document expires (days)",
    category: "OPERATIONS",
    schema: intSetting(365),
  },
  "ops.staleAfterDays": {
    label: "Flag a file stale after (days without activity)",
    category: "OPERATIONS",
    schema: z.coerce.number().int().min(1).max(365),
  },
  "ops.automationEnabled": {
    label: "Scheduled automation enabled",
    category: "OPERATIONS",
    schema: boolSetting,
  },
  /* ---- AI (Phase 9) ---- */
  "ai.enabled": { label: "AI assistant enabled", category: "AI", schema: boolSetting },
  "ai.autoExtraction": {
    label: "Run extraction automatically on upload",
    category: "AI",
    schema: boolSetting,
  },
  "ai.summaryLanguage": {
    label: "Summary language",
    category: "AI",
    schema: z.enum(["en", "fr", "ar"]),
  },
  "ai.minConfidencePercent": {
    label: "Confidence below this always needs a human",
    category: "AI",
    schema: z.coerce.number().int().min(0).max(100),
  },
  /* ---- Gmail (Phase 8) ---- */
  "gmail.enabled": { label: "Gmail intake enabled", category: "GMAIL", schema: boolSetting },
  "gmail.inboundRules": {
    label: "Inbound classification rules",
    category: "GMAIL",
    description:
      "Keywords per class, matched case-insensitively against subject and body. Email text is untrusted input: it may classify, never configure.",
    schema: z
      .array(
        z.object({
          classification: z.enum(["APPLICATION_UPDATE", "PAYMENT", "NEW_REQUEST", "SPAM", "OTHER"]),
          keywords: z.array(z.string().trim().min(2).max(60)).min(1).max(30),
        }),
      )
      .max(12),
  },
  "gmail.referencePattern": {
    label: "Application reference pattern",
    category: "GMAIL",
    description: "Regular expression used to find an ESSAFARIA reference in an inbound subject or body",
    schema: z.string().trim().min(3).max(200),
  },
  "gmail.autoAttachDocuments": {
    label: "Stage inbound attachments for review",
    category: "GMAIL",
    schema: boolSetting,
  },
};

export function validateSettingValue(key: string, value: unknown): { ok: boolean; error?: string; parsed?: unknown } {
  const def = SETTING_DEFINITIONS[key];
  if (!def) return { ok: false, error: `Unknown setting key: ${key}` };
  const res = def.schema.safeParse(value);
  if (!res.success) {
    return { ok: false, error: res.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, parsed: res.data };
}

export const userUpsertSchema = z.object({
  name: requiredText(120),
  email: emailField,
  role: z.enum([
    "SUPER_ADMIN",
    "ADMIN",
    "VISA_AGENT",
    "ACCOUNTING",
    "AGENCY_ADMIN",
    "AGENCY_USER",
  ]),
  password: z.preprocess(
    (v) => (isEmpty(v) ? null : v),
    z.string().min(10, "Password: minimum 10 characters").max(200).nullable(),
  ),
  isActive: boolField,
});

export const membershipAssignSchema = z.object({
  agencyId: idRef,
  userId: idRef,
  isPrimary: boolField,
});

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1).max(200),
});

export const mediaUploadSchema = z.object({
  kind: z.enum(["LOGO", "FAVICON", "HERO", "CONTENT", "DOCUMENT", "OTHER"]).default("CONTENT"),
  altText: optionalText(200),
});

/** Media upload constraints — validated again server-side (magic bytes, size). */
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;
export const MEDIA_ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

/* ---------------- operational layer schemas (Phase 3+) ---------------- */

const isoDateOrEmpty = z.preprocess((v) => (isEmpty(v) ? null : v), isoDate.nullable());

const optionalTrimmed = (max: number) => optionalText(max);

/** Date sanity: not in the future beyond `max`, not before `min`. Dates are
 *  compared as YYYY-MM-DD strings so timezone can't shift a boundary. */
function dateBetween(opts: { min?: string; maxToday?: boolean; notBefore?: string; label: string }) {
  return (value: string | null, ctx: z.RefinementCtx) => {
    if (!value) return;
    const today = new Date().toISOString().slice(0, 10);
    if (opts.maxToday && value > today) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${opts.label} cannot be in the future`, path: [opts.label] });
    }
    if (opts.notBefore && value < opts.notBefore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${opts.label} must be on or after ${opts.notBefore}`,
        path: [opts.label],
      });
    }
  };
}

export const applicationCreateSchema = z
  .object({
    /** selection by configured code OR by stable id — both are admin-facing handles */
    visaTypeCode: optionalText(40),
    visaTypeId: optionalIdRef,
    requestedCount: z.coerce.number().int().min(1).max(50).default(1),
    priorityCode: optionalText(20),
    travelDate: isoDateOrEmpty,
    notes: optionalTrimmed(4000),
    currencyCode: z.preprocess(
      (v) => (isEmpty(v) ? null : v),
      currencyCode.nullable(),
    ),
    /** Only honoured for staff; an agency user's value is ignored, never trusted. */
    agencyId: optionalIdRef,
  })
  .refine((v) => Boolean(v.visaTypeCode) !== Boolean(v.visaTypeId), {
    message: "Choose exactly one visa type (code or id)",
    path: ["visaTypeCode"],
  });

export const applicationUpdateSchema = z.object({
  requestedCount: z.coerce.number().int().min(1).max(50).optional(),
  priorityId: optionalIdRef.optional(),
  travelDate: isoDateOrEmpty.optional(),
  notes: optionalTrimmed(4000).optional(),
  caseOfficerUserId: optionalIdRef.optional(),
  consulateRef: optionalTrimmed(120).optional(),
});

export const statusTransitionSchema = z.object({
  toStatusCode: entityCode,
  reason: optionalTrimmed(2000),
});

export const submissionOverrideSchema = z.object({
  reason: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : ""),
    z.string().min(20, "An override reason must explain the decision (20+ characters)").max(2000),
  ),
});

export const applicantUpsertSchema = z
  .object({
    fullName: requiredText(160),
    firstName: optionalTrimmed(80),
    lastName: optionalTrimmed(80),
    dateOfBirth: isoDateOrEmpty,
    gender: z.preprocess(
      (v) => (isEmpty(v) ? null : String(v).trim().toUpperCase()),
      z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
    ),
    maritalStatus: z.preprocess(
      (v) => (isEmpty(v) ? null : String(v).trim().toUpperCase()),
      z.enum(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "OTHER"]).nullable(),
    ),
    nationalityCountryCode: optionalText(3),
    nationalityCountryId: optionalIdRef,
    birthCountryCode: optionalText(3),
    passportNumber: z.preprocess(
      (v) => (isEmpty(v) ? null : String(v).trim().toUpperCase().replace(/[^A-Z0-9]/g, "")),
      z.string().min(5).max(32).nullable(),
    ),
    passportIssueDate: isoDateOrEmpty,
    passportExpiryDate: isoDateOrEmpty,
    passportIssueCountryCode: optionalText(3),
    phone: optionalPhone,
    email: optionalEmail,
    address: optionalTrimmed(400),
    intendedEntryDate: isoDateOrEmpty,
    intendedExitDate: isoDateOrEmpty,
    isPrimary: boolField.default(false),
    notes: optionalTrimmed(2000),
  })
  .superRefine((v, ctx) => {
    dateBetween({ label: "dateOfBirth", maxToday: true, notBefore: "1900-01-01" })(v.dateOfBirth, ctx);
    if (v.passportIssueDate && v.passportExpiryDate && v.passportExpiryDate <= v.passportIssueDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Passport expiry must be after issue date", path: ["passportExpiryDate"] });
    }
    if (v.passportExpiryDate) {
      const today = new Date().toISOString().slice(0, 10);
      if (v.passportExpiryDate < today) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Passport is already expired — renew it before applying",
          path: ["passportExpiryDate"],
        });
      }
    }
    if (v.intendedEntryDate && v.intendedExitDate && v.intendedExitDate <= v.intendedEntryDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Exit date must be after entry date", path: ["intendedExitDate"] });
    }
    if (v.dateOfBirth && v.passportExpiryDate) {
      // sanity: a passport cannot predate the applicant's birth
      if (v.passportExpiryDate < v.dateOfBirth) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Dates are inconsistent", path: ["passportExpiryDate"] });
      }
    }
  });

export const documentUploadSchema = z.object({
  documentTypeCode: optionalText(40),
  documentTypeId: optionalIdRef,
  applicantId: optionalIdRef,
  agencyNotes: optionalTrimmed(2000),
}).refine((v) => Boolean(v.documentTypeCode) !== Boolean(v.documentTypeId), {
  message: "Choose exactly one document type (code or id)",
  path: ["documentTypeCode"],
});

export const documentReviewSchema = z.object({
  decision: z.enum(["ACCEPT", "REJECT", "NEEDS_REPLACEMENT"]),
  note: optionalTrimmed(2000),
  rejectionCode: optionalText(40),
  requireValidityDays: z.preprocess(
    (v) => (isEmpty(v) ? null : v),
    z.coerce.number().int().min(0).max(3650).nullable(),
  ),
});

export const walletCreditSchema = z.object({
  agencyId: idRef,
  amountCents: z.coerce.number().int("Whole cents only").min(1, "Credit must be positive").max(1_000_000_000_000),
  currencyCode: currencyCode,
  reason: z.preprocess((v) => (typeof v === "string" ? v.trim() : ""), z.string().min(5, "A reason is required for every money movement").max(500)),
  reference: optionalTrimmed(120),
  idempotencyKey: optionalTrimmed(120),
});

export const walletAdjustSchema = z.object({
  agencyId: idRef,
  amountCents: z.coerce.number().int("Whole cents only").max(1_000_000_000_000),
  kind: z.enum(["ADJUSTMENT", "REFUND"]),
  currencyCode: currencyCode,
  reason: z.preprocess((v) => (typeof v === "string" ? v.trim() : ""), z.string().min(5).max(500)),
  reference: optionalTrimmed(120),
  idempotencyKey: optionalTrimmed(120),
});

export const outboundMessageSchema = z.object({
  subject: requiredText(200),
  body: z.string().trim().min(1, "Message body is required").max(8000),
  templateCode: optionalText(40),
  applicationId: optionalIdRef,
});

export const applicationQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  statusCode: optionalText(40),
  agencyId: optionalIdRef,
  visaTypeId: optionalIdRef,
  priorityId: optionalIdRef,
  onlyBlocking: z.preprocess((v) => v === "true" || v === "on" || v === true, z.boolean()).optional(),
  onlyMine: z.preprocess((v) => v === "true" || v === "on" || v === true, z.boolean()).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

export const paginationSchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});
