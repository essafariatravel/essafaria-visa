import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uniqueIndex,
  index,
  jsonb,
  pgEnum,
  date,
  primaryKey,
  bigint,
} from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/* ============================================================
 * ESSAFARIA VISA OS — Database schema (PostgreSQL dialect)
 *
 * Design principles:
 *  - Business configuration (statuses, visa types, fees, branding,
 *    homepage, navigation…) is DATA, never code constants.
 *  - Stable IDs + active flags + restrict-delete preserve history.
 *  - Multi-tenancy is expressible: users ⇄ agencies via memberships.
 * ============================================================ */

const uuid = () => text("id").primaryKey().default(sql`gen_random_uuid()::text`);
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/* ------------------------------ enums ------------------------------ */

export const userRoleEnum = pgEnum("user_role", [
  "SUPER_ADMIN",
  "ADMIN",
  "VISA_AGENT",
  "ACCOUNTING",
  "AGENCY_ADMIN",
  "AGENCY_USER",
]);

export const agencyStatusEnum = pgEnum("agency_status", ["ACTIVE", "SUSPENDED", "INACTIVE"]);

export const feeTypeEnum = pgEnum("fee_type", ["VISA_FEE", "SERVICE_FEE", "B2B_PRICE"]);

export const publishStateEnum = pgEnum("publish_state", ["DRAFT", "PUBLISHED", "ARCHIVED"]);

export const navLocationEnum = pgEnum("nav_location", ["HEADER", "FOOTER"]);

export const mediaKindEnum = pgEnum("media_kind", [
  "LOGO",
  "FAVICON",
  "HERO",
  "CONTENT",
  "DOCUMENT",
  "OTHER",
]);

const AUDIT_ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "DEACTIVATE",
  "REACTIVATE",
  "REORDER",
  "PUBLISH",
  "UNPUBLISH",
  "LOGIN",
  "LOGOUT",
  "ASSIGN",
  "REMOVE",
  "UPLOAD",
  // operational actions added with the application-processing layer (Phase 3+)
  "SUBMIT",
  "TRANSITION",
  "OVERRIDE",
  "APPROVE",
  "REJECT",
  "REOPEN",
  "CHARGE",
  "CREDIT",
  "REVERSAL",
  "SEND",
  "RECEIVE",
  "ARCHIVE",
  "RESTORE",
  // private file access is logged too — who read which applicant document
  "DOWNLOAD",
] as const;

export const auditActionEnum = pgEnum("audit_action", AUDIT_ACTIONS as unknown as [
  AuditActionName,
  ...AuditActionName[],
]);

export type AuditActionName = (typeof AUDIT_ACTIONS)[number];

/* --- operational enums (Phase 3+) --------------------------------------
 * These are closed sets that describe SYSTEM STATE, not business
 * configuration. Anything a business user might want to rename or add
 * lives in a configuration TABLE instead (statuses, priorities, document
 * types, fees…) so it stays editable from the Back Office. */

export const applicationOriginEnum = pgEnum("application_origin", ["AGENCY_PORTAL", "BACK_OFFICE", "EMAIL"]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "DRAFT",
  "PENDING",
  "PARTIALLY_PAID",
  "PAID",
  "REFUNDED",
  "VOID",
]);

export const walletTxKindEnum = pgEnum("wallet_tx_kind", [
  "CREDIT",
  "DEBIT",
  "REVERSAL",
  "ADJUSTMENT",
  "REFUND",
]);

export const documentReviewStateEnum = pgEnum("document_review_state", [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "NEEDS_REPLACEMENT",
  "SUPERSEDED",
]);

export const deliveryStateEnum = pgEnum("delivery_state", [
  "QUEUED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
]);

export const channelEnum = pgEnum("channel", ["IN_APP", "EMAIL", "SMS", "GMAIL"]);

export const messageDirectionEnum = pgEnum("message_direction", ["INBOUND", "OUTBOUND"]);

export const aiRunStatusEnum = pgEnum("ai_run_status", ["OK", "FAILED", "SKIPPED", "STALE"]);

export const gmailConnectionStatusEnum = pgEnum("gmail_connection_status", [
  "DISCONNECTED",
  "CONNECTED",
  "ERROR",
]);

/* --- money --------------------------------------------------------------
 * All authoritative financial values use bigint minor units (cents).
 * integer (INT4) would cap at ~21.4M of currency units, which is not safe
 * for a cumulative wallet balance. Existing foundation money columns keep
 * their type; new columns are bigint. */
const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

/* ------------------------------ identity ------------------------------ */

export const users = pgTable(
  "users",
  {
    id: uuid(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("AGENCY_USER"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({
    emailUq: uniqueIndex("users_email_uq").on(sql`lower(${t.email})`),
    roleIdx: index("users_role_idx").on(t.role),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenUq: uniqueIndex("sessions_token_uq").on(t.tokenHash),
    expiryIdx: index("sessions_expiry_idx").on(t.expiresAt),
  }),
);

/* ------------------------------ geography ------------------------------ */

export const countries = pgTable(
  "countries",
  {
    id: uuid(),
    code: text("code").notNull(), // ISO-3166 alpha-2, admin-editable
    name: text("name").notNull(),
    region: text("region"),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (t) => ({
    codeUq: uniqueIndex("countries_code_uq").on(sql`upper(${t.code})`),
  }),
);

/* ------------------------------ agencies (tenants) ------------------------------ */

export const agencies = pgTable(
  "agencies",
  {
    id: uuid(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    email: text("email"),
    phone: text("phone"),
    city: text("city"),
    address: text("address"),
    contactPerson: text("contact_person"),
    billingInfo: text("billing_info"),
    notes: text("notes"),
    status: agencyStatusEnum("status").notNull().default("ACTIVE"),
    countryId: text("country_id").references(() => countries.id, { onDelete: "restrict" }),
    /* Wallet header (Phase 7). A CACHE of the ledger, never the source of
     * truth: it is only ever moved by a conditional UPDATE inside the same
     * transaction that writes the ledger row, so `sum(ledger) = balance`. */
    walletBalanceCents: bigint("wallet_balance_cents", { mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (t) => ({
    codeUq: uniqueIndex("agencies_code_uq").on(t.code),
    statusIdx: index("agencies_status_idx").on(t.status),
  }),
);

export const agencyMemberships = pgTable(
  "agency_memberships",
  {
    agencyId: text("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agencyId, t.userId] }),
    userIdx: index("memberships_user_idx").on(t.userId),
  }),
);

/* ------------------------------ visa catalog ------------------------------ */

export const visaCategories = pgTable(
  "visa_categories",
  {
    id: uuid(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (t) => ({ codeUq: uniqueIndex("visa_categories_code_uq").on(t.code) }),
);

export const visaTypes = pgTable(
  "visa_types",
  {
    id: uuid(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    countryId: text("country_id")
      .notNull()
      .references(() => countries.id, { onDelete: "restrict" }),
    categoryId: text("category_id").references(() => visaCategories.id, {
      onDelete: "restrict",
    }),
    description: text("description"),
    eligibilityNotes: text("eligibility_notes"),
    processingTimeDays: integer("processing_time_days"), // business days, configurable
    isActive: boolean("is_active").notNull().default(true),
    isFeatured: boolean("is_featured").notNull().default(false),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (t) => ({
    codeUq: uniqueIndex("visa_types_code_uq").on(t.code),
    countryIdx: index("visa_types_country_idx").on(t.countryId),
    activeIdx: index("visa_types_active_idx").on(t.isActive),
  }),
);

export const documentTypes = pgTable(
  "document_types",
  {
    id: uuid(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    allowedExtensions: jsonb("allowed_extensions").$type<string[]>().notNull().default([]),
    maxFileSizeMb: integer("max_file_size_mb"),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (t) => ({ codeUq: uniqueIndex("document_types_code_uq").on(t.code) }),
);

export const visaRequirements = pgTable(
  "visa_requirements",
  {
    id: uuid(),
    visaTypeId: text("visa_type_id")
      .notNull()
      .references(() => visaTypes.id, { onDelete: "cascade" }),
    documentTypeId: text("document_type_id")
      .notNull()
      .references(() => documentTypes.id, { onDelete: "restrict" }),
    isRequired: boolean("is_required").notNull().default(true),
    instructions: text("instructions"),
    validityDays: integer("validity_days"), // min document validity, future rules engine
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (t) => ({
    pairUq: uniqueIndex("visa_requirements_pair_uq").on(t.visaTypeId, t.documentTypeId),
    visaIdx: index("visa_requirements_visa_idx").on(t.visaTypeId),
  }),
);

/* ------------------------------ operations configuration ------------------------------ */

export const applicationStatuses = pgTable(
  "application_statuses",
  {
    id: uuid(),
    code: text("code").notNull(), // e.g. UNDER_REVIEW — referenced by future applications
    label: text("label").notNull(),
    color: text("color"), // hex, admin-picked
    description: text("description"),
    isTerminal: boolean("is_terminal").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    /* ---- workflow semantics (Phase 3): the state machine is DATA ----
     * allowedNextStatusCodes: null → any active status may follow (permissive
     * default so a fresh install works before the graph is configured);
     * [] → strictly no exits; list → only those codes.
     * requiresDocumentsComplete: submission-style gates demand a clean
     * checklist. customerVisible: hides internal states from the agency. */
    allowedNextStatusCodes: jsonb("allowed_next_status_codes").$type<string[] | null>(),
    requiresDocumentsComplete: boolean("requires_documents_complete").notNull().default(false),
    customerVisible: boolean("customer_visible").notNull().default(true),
    ...timestamps,
  },
  (t) => ({ codeUq: uniqueIndex("application_statuses_code_uq").on(t.code) }),
);

export const priorities = pgTable(
  "priorities",
  {
    id: uuid(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    color: text("color"),
    surchargePercent: integer("surcharge_percent").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (t) => ({ codeUq: uniqueIndex("priorities_code_uq").on(t.code) }),
);

export const currencies = pgTable(
  "currencies",
  {
    id: uuid(),
    // unique column constraint (not expression index) so visa_fees can FK to it
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    isBase: boolean("is_base").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => ({ codeIdx: index("currencies_code_idx").on(t.code) }),
);

export const visaFees = pgTable(
  "visa_fees",
  {
    id: uuid(),
    visaTypeId: text("visa_type_id")
      .notNull()
      .references(() => visaTypes.id, { onDelete: "cascade" }),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    feeType: feeTypeEnum("fee_type").notNull().default("SERVICE_FEE"),
    amountCents: integer("amount_cents").notNull(), // money as integer cents — no floats
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => ({
    comboUq: uniqueIndex("visa_fees_combo_uq").on(
      t.visaTypeId,
      t.currencyCode,
      t.feeType,
      t.effectiveFrom,
    ),
    visaIdx: index("visa_fees_visa_idx").on(t.visaTypeId),
  }),
);

/* ------------------------------ communication ------------------------------ */

export const communicationTemplates = pgTable(
  "communication_templates",
  {
    id: uuid(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    language: text("language").notNull().default("en"),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => ({
    codeLangUq: uniqueIndex("comm_templates_code_lang_uq").on(t.code, t.language),
  }),
);

/* ------------------------------ branding / CMS / settings ------------------------------ */

export const brandSettings = pgTable("brand_settings", {
  id: uuid(),
  brandName: text("brand_name").notNull().default("ESSAFARIA"),
  companyName: text("company_name").notNull().default("ESSAFARIA TRAVEL"),
  tagline: text("tagline"),
  primaryColor: text("primary_color").notNull().default("#0E7A6D"),
  secondaryColor: text("secondary_color").notNull().default("#13315C"),
  accentColor: text("accent_color").notNull().default("#D9A441"),
  backgroundColor: text("background_color").notNull().default("#F7F5F0"),
  textColor: text("text_color").notNull().default("#1B2430"),
  logoMediaId: text("logo_media_id"), // -> media.id (nullable: fallback mark)
  secondaryLogoMediaId: text("secondary_logo_media_id"),
  faviconMediaId: text("favicon_media_id"),
  buttonStyle: text("button_style").notNull().default("rounded"), // rounded|pill|square
  ...timestamps,
});

export const siteSettings = pgTable(
  "site_settings",
  {
    id: uuid(),
    key: text("key").notNull(), // e.g. contact.email
    category: text("category").notNull(), // GENERAL|CONTACT|EMAIL|SECURITY|...
    value: jsonb("value").notNull(),
    label: text("label"),
    description: text("description"),
    ...timestamps,
  },
  (t) => ({ keyUq: uniqueIndex("site_settings_key_uq").on(t.key) }),
);

export const homepageSections = pgTable(
  "homepage_sections",
  {
    id: uuid(),
    sectionType: text("section_type").notNull(), // hero|services|destinations|process|cta|contact|features|custom
    title: text("title"),
    subtitle: text("subtitle"),
    body: text("body"),
    ctaLabel: text("cta_label"),
    ctaHref: text("cta_href"),
    imageMediaId: text("image_media_id"),
    overlayOpacity: integer("overlay_opacity"), // 0..100 — validated numerics, not raw CSS
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    publishState: publishStateEnum("publish_state").notNull().default("DRAFT"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({
    orderIdx: index("homepage_sections_order_idx").on(t.displayOrder),
    pubIdx: index("homepage_sections_pub_idx").on(t.publishState, t.isActive),
  }),
);

export const navItems = pgTable(
  "nav_items",
  {
    id: uuid(),
    location: navLocationEnum("location").notNull().default("HEADER"),
    label: text("label").notNull(),
    href: text("href").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    isSystem: boolean("is_system").notNull().default(false), // protected core routes
    ...timestamps,
  },
  (t) => ({ locIdx: index("nav_items_loc_idx").on(t.location, t.isActive) }),
);

export const legalPages = pgTable(
  "legal_pages",
  {
    id: uuid(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    // Structured blocks — never raw HTML. Rendered by a safe block renderer.
    body: jsonb("body")
      .$type<Array<{ type: "h2" | "p" | "li"; text: string; level?: number }>>()
      .notNull()
      .default([]),
    publishState: publishStateEnum("publish_state").notNull().default("DRAFT"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({ slugUq: uniqueIndex("legal_pages_slug_uq").on(t.slug) }),
);

export const media = pgTable(
  "media",
  {
    id: uuid(),
    kind: mediaKindEnum("kind").notNull().default("OTHER"),
    filename: text("filename").notNull(),
    storageKey: text("storage_key").notNull(), // provider-relative; provider swappable
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    altText: text("alt_text"),
    width: integer("width"),
    height: integer("height"),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex("media_storage_key_uq").on(t.storageKey),
    kindIdx: index("media_kind_idx").on(t.kind),
  }),
);

/* ============================================================
 * OPERATIONAL LAYER (Phase 3+) — applications, applicants, documents,
 * financial records, notifications, integrations, AI.
 *
 * Historical-meaning rules applied throughout:
 *   • Every operational row points at configuration by STABLE ID
 *     (FK … ON DELETE RESTRICT) and carries the CODE/NAME it was
 *     created with as an immutable denormalized snapshot. Renaming or
 *     deactivating a status, fee or requirement afterwards can never
 *     rewrite what a closed application meant.
 *   • Money is integer minor units (bigint cents). No floats, ever.
 *   • Multi-step business operations run in one transaction with the
 *     audit row and the outbox row; conditional UPDATEs (not read-modify-
 *     write in application code) guard every race-sensitive balance move.
 * ============================================================ */

export const applicationReferenceCounters = pgTable("application_reference_counters", {
  period: text("period").primaryKey(), // e.g. "2026"
  lastNumber: integer("last_number").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const visaApplications = pgTable(
  "visa_applications",
  {
    id: uuid(),
    reference: text("reference").notNull(), // ESF-2026-000123, unique
    agencyId: text("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "restrict" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    origin: applicationOriginEnum("origin").notNull().default("AGENCY_PORTAL"),
    // --- catalog selection (stable ids + frozen codes) ---
    countryId: text("country_id")
      .notNull()
      .references(() => countries.id, { onDelete: "restrict" }),
    visaTypeId: text("visa_type_id")
      .notNull()
      .references(() => visaTypes.id, { onDelete: "restrict" }),
    categoryId: text("category_id").references(() => visaCategories.id, { onDelete: "restrict" }),
    countryName: text("country_name").notNull(),
    visaTypeName: text("visa_type_name").notNull(),
    visaTypeCode: text("visa_type_code").notNull(),
    // --- lifecycle (status is configuration-driven) ---
    statusId: text("status_id")
      .notNull()
      .references(() => applicationStatuses.id, { onDelete: "restrict" }),
    statusSnapshotAt: timestamp("status_snapshot_at", { withTimezone: true }).notNull().defaultNow(),
    priorityId: text("priority_id").references(() => priorities.id, { onDelete: "restrict" }),
    prioritySnapshotAt: timestamp("priority_snapshot_at", { withTimezone: true }),
    // --- submission / gating ---
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedByUserId: text("submitted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    submissionOverrideReason: text("submission_override_reason"),
    submissionOverrideBy: text("submission_override_by").references(() => users.id, { onDelete: "set null" }),
    submissionOverrideAt: timestamp("submission_override_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // --- operational detail ---
    travelDate: date("travel_date", { mode: "string" }),
    targetProcessingDays: integer("target_processing_days"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    requestedCount: integer("requested_count").notNull().default(1),
    applicantCount: integer("applicant_count").notNull().default(0), // cache; enforced <= 50
    notes: text("notes"), // agency-visible
    staffNotes: text("staff_notes"), // staff-only — never serialized to agency reads
    caseOfficerUserId: text("case_officer_user_id").references(() => users.id, { onDelete: "set null" }),
    consulateRef: text("consulate_ref"),
    // --- requirement/pricing snapshot pointer (authoritative JSON below) ---
    currentSnapshotId: text("current_snapshot_id"),
    /* Denormalized submission gate: recomputed whenever documents move, and
     * read by the gate + every list view (so "waiting on documents" is a
     * single indexed filter instead of a checklist fan-out per row). */
    checklistComplete: boolean("checklist_complete").notNull().default(false),
    /** A staff override let this file pass a gate its checklist did not —
     *  permanently visible, so a reviewer knows the file skipped a step. */
    gateOverridden: boolean("gate_overridden").notNull().default(false),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => ({
    referenceUq: uniqueIndex("applications_reference_uq").on(t.reference),
    agencyIdx: index("applications_agency_idx").on(t.agencyId, t.createdAt),
    statusIdx: index("applications_status_idx").on(t.statusId),
    activityIdx: index("applications_activity_idx").on(t.lastActivityAt),
    // the desk's default filter ("waiting on documents") and the review queue
    // both probe this pair, so it gets a real index instead of a scan
    blockingIdx: index("applications_blocking_idx").on(t.agencyId, t.checklistComplete),
    visaIdx: index("applications_visa_type_idx").on(t.visaTypeId),
  }),
);

export const applicants = pgTable(
  "applicants",
  {
    id: uuid(),
    applicationId: text("application_id")
      .notNull()
      .references(() => visaApplications.id, { onDelete: "cascade" }),
    agencyId: text("agency_id") // denormalized so tenancy never depends on a join
      .notNull()
      .references(() => agencies.id, { onDelete: "restrict" }),
    // identity (validated by the shared applicant schema, not by the client)
    fullName: text("full_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    nationalityCountryId: text("nationality_country_id").references(() => countries.id, {
      onDelete: "restrict",
    }),
    birthCountryId: text("birth_country_id").references(() => countries.id, { onDelete: "restrict" }),
    gender: text("gender"),
    maritalStatus: text("marital_status"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    // passport
    passportNumber: text("passport_number"),
    passportIssueDate: date("passport_issue_date", { mode: "string" }),
    passportExpiryDate: date("passport_expiry_date", { mode: "string" }),
    passportIssueCountryId: text("passport_issue_country_id").references(() => countries.id, {
      onDelete: "restrict",
    }),
    // travel
    intendedEntryDate: date("intended_entry_date", { mode: "string" }),
    intendedExitDate: date("intended_exit_date", { mode: "string" }),
    // ordering / state
    displayOrder: integer("display_order").notNull().default(0),
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => ({
    appIdx: index("applicants_application_idx").on(t.applicationId),
    agencyIdx: index("applicants_agency_idx").on(t.agencyId),
    passportIdx: index("applicants_passport_idx").on(t.passportNumber),
  }),
);

/** Immutable JSON snapshot of requirements + pricing + workflow config at the
 *  moment a file was priced/submitted. Rows are never updated — a new
 *  snapshot row is inserted and the application's pointer moved. */
export const applicationSnapshots = pgTable(
  "application_snapshots",
  {
    id: uuid(),
    applicationId: text("application_id")
      .notNull()
      .references(() => visaApplications.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(), // CREATED | SUBMITTED | CONFIG_CHANGED | RECHECK
    requirements: jsonb("requirements")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    fees: jsonb("fees").$type<Array<Record<string, unknown>>>().notNull().default([]),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull().default(0),
    currencyCode: text("currency_code"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    capturedBy: text("captured_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({ appIdx: index("snapshots_application_idx").on(t.applicationId) }),
);

/** Append-only timeline: status moves, documents, overrides, notes, money.
 *  `type` is plain text on purpose — new event kinds must not need a migration. */
export const applicationEvents = pgTable(
  "application_events",
  {
    id: uuid(),
    applicationId: text("application_id")
      .notNull()
      .references(() => visaApplications.id, { onDelete: "cascade" }),
    agencyId: text("agency_id").references(() => agencies.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    actorKind: text("actor_kind").notNull().default("USER"), // USER | SYSTEM | AUTOMATION | GMAIL | AI
    fromStatusId: text("from_status_id").references(() => applicationStatuses.id, { onDelete: "restrict" }),
    toStatusId: text("to_status_id").references(() => applicationStatuses.id, { onDelete: "restrict" }),
    message: text("message"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    customerVisible: boolean("customer_visible").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    appIdx: index("events_application_idx").on(t.applicationId, t.createdAt),
    agencyIdx: index("events_agency_idx").on(t.agencyId),
    typeIdx: index("events_type_idx").on(t.type),
  }),
);

export const applicationDocuments = pgTable(
  "application_documents",
  {
    id: uuid(),
    applicationId: text("application_id")
      .notNull()
      .references(() => visaApplications.id, { onDelete: "cascade" }),
    applicantId: text("applicant_id").references(() => applicants.id, { onDelete: "cascade" }),
    agencyId: text("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "restrict" }),
    documentTypeId: text("document_type_id")
      .notNull()
      .references(() => documentTypes.id, { onDelete: "restrict" }),
    documentTypeCode: text("document_type_code").notNull(), // frozen label for history
    requirementId: text("requirement_id").references(() => visaRequirements.id, {
      onDelete: "set null",
    }),
    wasRequiredAtUpload: boolean("was_required_at_upload").notNull().default(true),
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    /* Self-reference: the callback cannot be typed from within its own
     * table's initializer, so it is declared as a loose column reference.
     * Postgres resolves the target at DDL time (documents_document_id_fkey). */
    supersedesDocumentId: text("supersedes_document_id").references(
      (): AnyPgColumn => applicationDocuments.id,
      { onDelete: "set null" },
    ),
    contentHash: text("content_hash"), // sha256 of the stored bytes — dedupe + integrity
    bytes: integer("bytes").notNull().default(0),
    originalFilename: text("original_filename"),
    source: text("source").notNull().default("PORTAL"), // PORTAL | BACK_OFFICE | GMAIL | AI
    externalId: text("external_id"), // e.g. gmail attachment id, for import idempotency
    reviewState: documentReviewStateEnum("review_state").notNull().default("PENDING"),
    isCurrent: boolean("is_current").notNull().default(true),
    staffNotes: text("staff_notes"),
    agencyNotes: text("agency_notes"),
    rejectionCode: text("rejection_code"),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    // --- AI assistance (advisory only; never authoritative) ---
    aiExtracted: jsonb("ai_extracted").$type<Record<string, unknown> | null>(),
    aiConfidence: integer("ai_confidence"), // 0..100
    aiReviewedByStaff: boolean("ai_reviewed_by_staff").notNull().default(false),
    aiRunId: text("ai_run_id"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => ({
    appIdx: index("documents_application_idx").on(t.applicationId),
    agencyIdx: index("documents_agency_idx").on(t.agencyId),
    currentUq: uniqueIndex("documents_current_per_slot_uq").on(
      t.applicationId,
      t.documentTypeId,
      sql`coalesce(${t.applicantId}, '')`,
    ).where(sql`${t.isCurrent} = true`),
    typeIdx: index("documents_type_idx").on(t.documentTypeId, t.reviewState),
    reviewIdx: index("documents_review_idx").on(t.reviewState, t.uploadedAt),
    mediaUq: uniqueIndex("documents_media_uq").on(t.mediaId),
  }),
);

/* ---------------- financial records ---------------- */

export const invoices = pgTable(
  "invoices",
  {
    id: uuid(),
    number: text("number").notNull(), // INV-2026-000001
    agencyId: text("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "restrict" }),
    applicationId: text("application_id").references(() => visaApplications.id, {
      onDelete: "restrict",
    }),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    status: invoiceStatusEnum("status").notNull().default("DRAFT"),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
    paidCents: bigint("paid_cents", { mode: "number" }).notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => ({
    numberUq: uniqueIndex("invoices_number_uq").on(t.number),
    agencyIdx: index("invoices_agency_idx").on(t.agencyId, t.createdAt),
    appIdx: index("invoices_application_idx").on(t.applicationId),
    statusIdx: index("invoices_status_idx").on(t.status),
  }),
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: uuid(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => visaApplications.id, { onDelete: "restrict" }),
    // frozen description of what was billed (survives later fee edits)
    description: text("description").notNull(),
    feeType: feeTypeEnum("fee_type").notNull().default("SERVICE_FEE"),
    unitAmountCents: bigint("unit_amount_cents", { mode: "number" }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    applicantId: text("applicant_id").references(() => applicants.id, { onDelete: "restrict" }),
    visaFeeId: text("visa_fee_id").references(() => visaFees.id, { onDelete: "restrict" }),
    snapshotId: text("snapshot_id").references(() => applicationSnapshots.id, {
      onDelete: "restrict",
    }),
    // charge state machine: PENDING → CHARGED | WAIVED ; CHARGED → REVERSED
    chargeStatus: text("charge_status").notNull().default("PENDING"),
    chargedAt: timestamp("charged_at", { withTimezone: true }),
    walletTxId: text("wallet_tx_id"),
    /** Idempotency anchor: one charge per (application, description, feeType).
     * A retry reuses the existing item instead of creating a second one. */
    chargeKey: text("charge_key").notNull(),
    ...timestamps,
  },
  (t) => ({
    chargeKeyUq: uniqueIndex("invoice_items_charge_key_uq").on(t.invoiceId, t.chargeKey),
    invoiceIdx: index("invoice_items_invoice_idx").on(t.invoiceId),
    appIdx: index("invoice_items_application_idx").on(t.applicationId),
  }),
);

/** Append-only ledger. Rows are never updated or deleted — corrections are
 *  new rows (REVERSAL/ADJUSTMENT) referencing the transaction they fix. */
export const agencyWalletTransactions = pgTable(
  "agency_wallet_transactions",
  {
    id: uuid(),
    agencyId: text("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "restrict" }),
    currencyCode: text("currency_code")
      .notNull()
      .references(() => currencies.code, { onDelete: "restrict" }),
    kind: walletTxKindEnum("kind").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(), // signed: debit < 0
    balanceBeforeCents: bigint("balance_before_cents", { mode: "number" }).notNull(),
    balanceAfterCents: bigint("balance_after_cents", { mode: "number" }).notNull(),
    applicationId: text("application_id").references(() => visaApplications.id, {
      onDelete: "restrict",
    }),
    invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
    invoiceItemId: text("invoice_item_id").references(() => invoiceItems.id, {
      onDelete: "restrict",
    }),
    reversesTxId: text("reverses_tx_id").references(
      (): AnyPgColumn => agencyWalletTransactions.id,
      {
      onDelete: "restrict",
    }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    reason: text("reason").notNull(),
    reference: text("reference"), // external evidence, e.g. bank ref
    /** Client-supplied dedupe key (Idempotency-Key). Unique per agency. */
    idempotencyKey: text("idempotency_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idemUq: uniqueIndex("wallet_idempotency_uq").on(t.agencyId, t.idempotencyKey).where(
      sql`${t.idempotencyKey} is not null`,
    ),
    agencyIdx: index("wallet_agency_idx").on(t.agencyId, t.occurredAt),
    appIdx: index("wallet_application_idx").on(t.applicationId),
    chainIdx: index("wallet_chain_idx").on(t.reversesTxId),
  }),
);

/* ---------------- notifications (transactional outbox) ---------------- */

export const notifications = pgTable(
  "notifications",
  {
    id: uuid(),
    agencyId: text("agency_id").references(() => agencies.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    staffOnly: boolean("staff_only").notNull().default(false),
    audienceRole: text("audience_role"), // e.g. AGENCY_ADMIN | VISA_AGENT | ACCOUNTING
    applicationId: text("application_id").references(() => visaApplications.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(), // STATUS_CHANGED | MISSING_DOCUMENTS | DOCUMENT_REJECTED | BALANCE_LOW …
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    severity: text("severity").notNull().default("INFO"), // INFO | ACTION_REQUIRED | WARNING | SUCCESS
    readAt: timestamp("read_at", { withTimezone: true }),
    readBy: text("read_by").references(() => users.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupeUq: uniqueIndex("notifications_dedupe_uq").on(t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
    agencyIdx: index("notifications_agency_idx").on(t.agencyId, t.createdAt),
    userIdx: index("notifications_user_idx").on(t.userId, t.readAt),
    kindIdx: index("notifications_kind_idx").on(t.kind),
  }),
);

/** Outbox row = the delivery intent. Business writes and the outbox insert
 *  share one transaction, so an event is never recorded without its intent,
 *  and delivery workers never invent events. */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid(),
    notificationId: text("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull().default("EMAIL"),
    to: text("to"),
    templateCode: text("template_code"),
    subject: text("subject"),
    body: text("body"),
    state: deliveryStateEnum("state").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    providerMessageId: text("provider_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idemUq: uniqueIndex("deliveries_idempotency_uq").on(t.idempotencyKey).where(
      sql`${t.idempotencyKey} is not null`,
    ),
    readyIdx: index("deliveries_ready_idx").on(t.state, t.nextAttemptAt),
    notifIdx: index("deliveries_notification_idx").on(t.notificationId),
  }),
);

/* ---------------- automation ledger ---------------- */

export const taskRuns = pgTable(
  "task_runs",
  {
    id: uuid(),
    taskKey: text("task_key").notNull(),
    runKey: text("run_key").notNull(), // daily idempotency bucket, e.g. "2026-09-16"
    status: text("status").notNull().default("RUNNING"), // RUNNING | COMPLETED | FAILED
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    runUq: uniqueIndex("task_runs_key_uq").on(t.taskKey, t.runKey),
    statusIdx: index("task_runs_status_idx").on(t.status, t.startedAt),
  }),
);

/* ---------------- communication (Gmail integration, Phase 8) ---------------- */

export const gmailConnections = pgTable("gmail_connections", {
  id: uuid(),
  label: text("label").notNull(),
  emailAddress: text("email_address").notNull(),
  status: gmailConnectionStatusEnum("status").notNull().default("DISCONNECTED"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  clientIdRef: text("client_id_ref"), // env var NAME, never the secret itself
  clientSecretRef: text("client_secret_ref"),
  redirectUri: text("redirect_uri"),
  /* The refresh token is stored sealed (AES-256-GCM with a key from an env
   * reference). It is never returned by any read path, and only the sync worker
   * and the callback handler decrypt it. */
  refreshTokenCipher: text("refresh_token_cipher"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  refreshTokenRotatedAt: timestamp("refresh_token_rotated_at", { withTimezone: true }),
  lastHistoryId: text("last_history_id"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});

/** Staged inbound attachment, awaiting a human decision. Nothing here mutates a
 *  file until staff link it, and linking runs the normal upload pipeline. */
export const communications = pgTable(
  "communications",
  {
    id: uuid(),
    threadId: text("thread_id"),
    direction: messageDirectionEnum("direction").notNull(),
    agencyId: text("agency_id").references(() => agencies.id, { onDelete: "cascade" }),
    applicationId: text("application_id").references(() => visaApplications.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    channel: channelEnum("channel").notNull().default("EMAIL"),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    subject: text("subject"),
    body: text("body"),
    bodyFormat: text("body_format").notNull().default("text"),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    matchedBy: text("matched_by"), // REFERENCE | SENDER | THREAD | MANUAL | NONE
    matchConfidence: integer("match_confidence"), // 0..100
    aiSummary: text("ai_summary"),
    aiSuggestedReply: text("ai_suggested_reply"),
    aiRunId: text("ai_run_id"),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    sendState: deliveryStateEnum("send_state"),
    redacted: boolean("redacted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    msgUq: uniqueIndex("communications_message_id_uq").on(t.messageId).where(
      sql`${t.messageId} is not null`,
    ),
    appIdx: index("communications_application_idx").on(t.applicationId, t.sentAt),
    agencyIdx: index("communications_agency_idx").on(t.agencyId),
    threadIdx: index("communications_thread_idx").on(t.threadId),
  }),
);

export const gmailMessages = pgTable(
  "gmail_messages",
  {
    id: uuid(),
    connectionId: text("connection_id").references(() => gmailConnections.id, { onDelete: "set null" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id"),
    fromAddress: text("from_address"),
    toAddresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
    subject: text("subject"),
    snippet: text("snippet"),
    bodyText: text("body_text"),
    bodyHtmlRedacted: boolean("body_html_redacted").notNull().default(false),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    // classification / matching
    classification: text("classification"), // APPLICATION_UPDATE | PAYMENT | NEW_REQUEST | SPAM | OTHER
    classificationSource: text("classification_source"), // RULES | AI
    classificationConfidence: integer("classification_confidence"),
    matchedAgencyId: text("matched_agency_id").references(() => agencies.id, { onDelete: "set null" }),
    matchedApplicationId: text("application_id").references(() => visaApplications.id, {
      onDelete: "set null",
    }),
    matchConfidence: integer("match_confidence"),
    matchedBy: text("matched_by"),
    requiresReview: boolean("requires_review").notNull().default(true),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    communicationId: text("communication_id").references(() => communications.id, {
      onDelete: "set null",
    }),
    importError: text("import_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    gmailUq: uniqueIndex("gmail_message_uq").on(t.connectionId, t.gmailMessageId),
    matchIdx: index("gmail_match_idx").on(t.matchedApplicationId),
    reviewIdx: index("gmail_review_idx").on(t.requiresReview, t.receivedAt),
  }),
);

export const gmailAttachments = pgTable(
  "gmail_attachments",
  {
    id: uuid(),
    messageId: text("message_id")
      .notNull()
      .references(() => gmailMessages.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    mediaId: text("media_id").references(() => media.id, { onDelete: "set null" }),
    documentId: text("document_id").references(() => applicationDocuments.id, { onDelete: "set null" }),
    applicantGuess: text("applicant_guess"),
    suggestedDocumentTypeCode: text("suggested_document_type_code"),
    confidence: integer("confidence"),
    linkedBy: text("linked_by").references(() => users.id, { onDelete: "set null" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    msgAttUq: uniqueIndex("gmail_attachment_uq").on(t.messageId, t.attachmentId),
    docIdx: index("gmail_attachment_document_idx").on(t.documentId),
  }),
);

/* ---------------- AI copilot (advisory layer, Phase 9) ---------------- */

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid(),
    purpose: text("purpose").notNull(), // EXTRACTION | SUMMARY | CONSISTENCY | NEXT_ACTIONS | DRAFT | ASSISTANT
    agencyId: text("agency_id").references(() => agencies.id, { onDelete: "cascade" }),
    applicationId: text("application_id").references(() => visaApplications.id, { onDelete: "cascade" }),
    documentId: text("document_id").references(() => applicationDocuments.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    provider: text("provider").notNull().default("none"),
    model: text("model"),
    status: aiRunStatusEnum("status").notNull().default("OK"),
    confidence: integer("confidence"), // 0..100, never hidden from humans
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output").$type<Record<string, unknown>>().notNull().default({}),
    basis: jsonb("basis").$type<string[]>().notNull().default([]), // what configured data it read
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    appIdx: index("ai_runs_application_idx").on(t.applicationId, t.createdAt),
    purposeIdx: index("ai_runs_purpose_idx").on(t.purpose),
    docIdx: index("ai_runs_document_idx").on(t.documentId),
  }),
);

/** AI may only PROPOSE. Nothing here mutates business state until a human
 *  accepts, and acceptance is itself audited as a human action. */
export const aiSuggestions = pgTable(
  "ai_suggestions",
  {
    id: uuid(),
    runId: text("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    agencyId: text("agency_id").references(() => agencies.id, { onDelete: "cascade" }),
    applicationId: text("application_id").references(() => visaApplications.id, { onDelete: "cascade" }),
    documentId: text("document_id").references(() => applicationDocuments.id, { onDelete: "cascade" }),
    // which traveller a FIELD_VALUE belongs to — without this an accepted value
    // would have no honest target
    applicantId: text("applicant_id").references(() => applicants.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // MISSING_DOCUMENT | INCONSISTENCY | FOLLOW_UP | DRAFT_REPLY | PRIORITY | FIELD_VALUE
    field: text("field"),
    proposedValue: text("proposed_value"),
    rationale: text("rationale"),
    confidence: integer("confidence").notNull().default(0),
    requiresHumanReview: boolean("requires_human_review").notNull().default(true),
    status: text("status").notNull().default("PROPOSED"), // PROPOSED | ACCEPTED | DISMISSED | SUPERSEDED
    actedBy: text("acted_by").references(() => users.id, { onDelete: "set null" }),
    actedAt: timestamp("acted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    appIdx: index("ai_suggestions_application_idx").on(t.applicationId, t.status),
    runIdx: index("ai_suggestions_run_idx").on(t.runId),
    openIdx: index("ai_suggestions_open_idx").on(t.status, t.confidence),
  }),
);

/* ---------------- login throttling (Phase 10 hardening) ---------------- */

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid(),
    key: text("key").notNull(), // normalized email
    success: boolean("success").notNull().default(false),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyIdx: index("login_attempts_key_idx").on(t.key, t.createdAt),
  }),
);

/* ---------------- audit ---------------- */

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"), // denormalized copy survives user deletion
    action: auditActionEnum("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agencyId: text("agency_id").references(() => agencies.id, { onDelete: "set null" }),
    changes: jsonb("changes"), // { before, after } where practical
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index("audit_entity_idx").on(t.entityType, t.entityId),
    actorIdx: index("audit_actor_idx").on(t.actorId),
    createdIdx: index("audit_created_idx").on(t.createdAt),
  }),
);

/* ------------------------------ inferred types ------------------------------ */

export type User = typeof users.$inferSelect;
export type Agency = typeof agencies.$inferSelect;
export type Country = typeof countries.$inferSelect;
export type VisaCategory = typeof visaCategories.$inferSelect;
export type VisaType = typeof visaTypes.$inferSelect;
export type DocumentType = typeof documentTypes.$inferSelect;
export type VisaRequirement = typeof visaRequirements.$inferSelect;
export type ApplicationStatus = typeof applicationStatuses.$inferSelect;
export type Priority = typeof priorities.$inferSelect;
export type Currency = typeof currencies.$inferSelect;
export type VisaFee = typeof visaFees.$inferSelect;
export type CommunicationTemplate = typeof communicationTemplates.$inferSelect;
export type BrandSettings = typeof brandSettings.$inferSelect;
export type SiteSetting = typeof siteSettings.$inferSelect;
export type HomepageSection = typeof homepageSections.$inferSelect;
export type NavItem = typeof navItems.$inferSelect;
export type LegalPage = typeof legalPages.$inferSelect;
export type Media = typeof media.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;

/* operational layer (Phase 3+) */
export type VisaApplication = typeof visaApplications.$inferSelect;
export type Applicant = typeof applicants.$inferSelect;
export type ApplicationSnapshot = typeof applicationSnapshots.$inferSelect;
export type ApplicationEvent = typeof applicationEvents.$inferSelect;
export type ApplicationDocument = typeof applicationDocuments.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type WalletTransaction = typeof agencyWalletTransactions.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type TaskRun = typeof taskRuns.$inferSelect;
export type Communication = typeof communications.$inferSelect;
export type GmailMessage = typeof gmailMessages.$inferSelect;
export type GmailAttachment = typeof gmailAttachments.$inferSelect;
export type GmailConnection = typeof gmailConnections.$inferSelect;
export type AiRun = typeof aiRuns.$inferSelect;
export type AiSuggestion = typeof aiSuggestions.$inferSelect;
export type LoginAttempt = typeof loginAttempts.$inferSelect;

/** Checklist item derived by merging a requirement snapshot with live document state. */
export interface ChecklistItem {
  requirementId: string;
  documentTypeId: string;
  documentTypeCode: string;
  documentTypeName: string;
  isRequired: boolean;
  instructions: string | null;
  validityDays: number | null;
  allowedExtensions: string[];
  maxFileSizeMb: number | null;
  state:
    | "NOT_APPLICABLE"
    | "MISSING"
    | "PENDING_REVIEW"
    | "ACCEPTED"
    | "REJECTED"
    | "EXPIRED"
    | "NEEDS_REPLACEMENT";
  documentId: string | null;
  documentVersion: number | null;
  documentReviewState: string | null;
  reviewedAt: string | null;
  expiresAt: string | null;
  applicantId: string | null;
  satisfiedByCurrentDocument: boolean;
}
