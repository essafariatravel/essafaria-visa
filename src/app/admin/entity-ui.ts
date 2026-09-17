import type { Entities } from "@/lib/crud";

/* ============================================================
 * UI descriptors for the generic configuration editors.
 * Data → table + form rendering. Adding a new simple config
 * entity later means adding a descriptor, not a new screen.
 * ============================================================ */

export type FieldType = "text" | "textarea" | "number" | "checkbox" | "color" | "date" | "select" | "tags";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  /** select options resolved server-side per page render */
  optionsFrom?: "countries" | "visaCategories" | "documentTypes" | "currencies" | "visaTypes";
  options?: Array<{ value: string; label: string }>;
  full?: boolean; // span two columns
}

export interface ColumnDef {
  key: string;
  label: string;
  render?: "text" | "bool" | "color" | "code" | "cents" | "long";
}

export interface ResourceUi {
  title: string;
  subtitle: string;
  columns: ColumnDef[];
  fields: FieldDef[];
}

export const ENTITY_UI: Partial<Record<Entities, ResourceUi>> = {
  countries: {
    title: "Countries",
    subtitle: "Every country available to the visa catalog. Deactivate to hide everywhere.",
    columns: [
      { key: "code", label: "Code", render: "code" },
      { key: "name", label: "Name" },
      { key: "region", label: "Region", render: "long" },
      { key: "displayOrder", label: "Order" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "code", label: "ISO code", type: "text", required: true, hint: "2–3 uppercase letters, e.g. FR" },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "region", label: "Region", type: "text" },
      { name: "displayOrder", label: "Display order", type: "number" },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
  "visa-categories": {
    title: "Visa Categories",
    subtitle: "Broad groupings: short stay, work, study…",
    columns: [
      { key: "code", label: "Code", render: "code" },
      { key: "name", label: "Name" },
      { key: "description", label: "Description", render: "long" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true, hint: "e.g. SHORT_STAY" },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "description", label: "Description", type: "textarea", full: true },
      { name: "displayOrder", label: "Display order", type: "number" },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
  "visa-types": {
    title: "Visa Types",
    subtitle: "The sellable catalog. Requirements are edited per type.",
    columns: [
      { key: "code", label: "Code", render: "code" },
      { key: "name", label: "Name" },
      { key: "processingTimeDays", label: "Days" },
      { key: "isFeatured", label: "Featured", render: "bool" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "countryId", label: "Country", type: "select", required: true, optionsFrom: "countries" },
      { name: "categoryId", label: "Category", type: "select", optionsFrom: "visaCategories" },
      { name: "processingTimeDays", label: "Processing (business days)", type: "number" },
      { name: "displayOrder", label: "Display order", type: "number" },
      { name: "isFeatured", label: "Featured on homepage", type: "checkbox" },
      { name: "isActive", label: "Active", type: "checkbox" },
      { name: "description", label: "Description", type: "textarea", full: true },
      { name: "eligibilityNotes", label: "Eligibility notes", type: "textarea", full: true },
    ],
  },
  "document-types": {
    title: "Document Types",
    subtitle: "Library of documents an applicant can be asked to provide.",
    columns: [
      { key: "code", label: "Code", render: "code" },
      { key: "name", label: "Name" },
      { key: "allowedExtensions", label: "Formats", render: "long" },
      { key: "maxFileSizeMb", label: "Max MB" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "description", label: "Description", type: "textarea", full: true },
      { name: "allowedExtensions", label: "Allowed extensions", type: "tags", hint: "comma separated: pdf, jpg, png" },
      { name: "maxFileSizeMb", label: "Max file size (MB)", type: "number" },
      { name: "displayOrder", label: "Display order", type: "number" },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
  statuses: {
    title: "Application Statuses",
    subtitle: "Workflow states. Rename freely — history keeps pointing at stable IDs.",
    columns: [
      { key: "color", label: "", render: "color" },
      { key: "label", label: "Label" },
      { key: "code", label: "Code", render: "code" },
      { key: "requiresDocumentsComplete", label: "Docs gate", render: "bool" },
      { key: "customerVisible", label: "Agency-visible", render: "bool" },
      { key: "isTerminal", label: "Terminal", render: "bool" },
      { key: "displayOrder", label: "Order" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true, hint: "e.g. UNDER_REVIEW" },
      { name: "label", label: "Label", type: "text", required: true },
      { name: "color", label: "Badge colour", type: "color", required: true },
      { name: "description", label: "Description", type: "textarea", full: true },
      {
        name: "allowedNextStatusCodes",
        label: "Allowed next statuses",
        type: "textarea",
        full: true,
        hint: "comma-separated codes, e.g. DOCUMENTS_RECEIVED, CANCELLED — leave empty to allow any active status; use no exits to freeze a state",
      },
      {
        name: "requiresDocumentsComplete",
        label: "Requires a complete checklist",
        type: "checkbox",
        hint: "entering this status enforces the document gate (staff may override with a reason)",
      },
      { name: "customerVisible", label: "Visible to agencies", type: "checkbox", hint: "internal states are hidden from the partner portal" },
      { name: "isTerminal", label: "Terminal status", type: "checkbox", hint: "files in this state stop moving" },
      { name: "displayOrder", label: "Display order", type: "number" },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
  priorities: {
    title: "Priorities",
    subtitle: "Surcharge % is applied on top of service fees when processing later.",
    columns: [
      { key: "color", label: "", render: "color" },
      { key: "label", label: "Label" },
      { key: "code", label: "Code", render: "code" },
      { key: "surchargePercent", label: "Surcharge %" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true },
      { name: "label", label: "Label", type: "text", required: true },
      { name: "color", label: "Badge colour", type: "color", required: true },
      { name: "surchargePercent", label: "Surcharge %", type: "number" },
      { name: "displayOrder", label: "Display order", type: "number" },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
  currencies: {
    title: "Currencies",
    subtitle: "Currencies available to pricing.",
    columns: [
      { key: "code", label: "Code", render: "code" },
      { key: "name", label: "Name" },
      { key: "symbol", label: "Symbol" },
      { key: "isBase", label: "Base", render: "bool" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "code", label: "ISO code", type: "text", required: true, hint: "3 letters, e.g. EUR" },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "symbol", label: "Symbol", type: "text", required: true },
      { name: "isBase", label: "Base currency", type: "checkbox" },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
  fees: {
    title: "Fees & Pricing",
    subtitle: "Effective-dated price rows per visa type. Amounts in whole cents.",
    columns: [
      { key: "feeType", label: "Type", render: "code" },
      { key: "amountCents", label: "Amount", render: "cents" },
      { key: "currencyCode", label: "Currency" },
      { key: "effectiveFrom", label: "Effective from" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "visaTypeId", label: "Visa type", type: "select", required: true, optionsFrom: "visaTypes" },
      {
        name: "feeType",
        label: "Fee type",
        type: "select",
        required: true,
        options: [
          { value: "VISA_FEE", label: "Visa fee (government)" },
          { value: "SERVICE_FEE", label: "Service fee" },
          { value: "B2B_PRICE", label: "B2B price" },
        ],
      },
      { name: "currencyCode", label: "Currency", type: "select", required: true, optionsFrom: "currencies" },
      { name: "amountCents", label: "Amount in cents", type: "number", required: true, hint: "€45.00 = 4500" },
      { name: "effectiveFrom", label: "Effective from", type: "date", required: true },
      { name: "notes", label: "Notes", type: "textarea", full: true },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
  templates: {
    title: "Communication Templates",
    subtitle: "Email copy with whitelisted {{variables}}. Nothing executes.",
    columns: [
      { key: "code", label: "Code", render: "code" },
      { key: "name", label: "Name" },
      { key: "subject", label: "Subject", render: "long" },
      { key: "language", label: "Lang" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "subject", label: "Subject", type: "text", required: true },
      { name: "body", label: "Body", type: "textarea", full: true, required: true, hint: "Allowed variables shown in help below" },
      { name: "language", label: "Language", type: "text", hint: "en, fr, ar…" },
      { name: "description", label: "Description", type: "text", full: true },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
  navigation: {
    title: "Site Navigation",
    subtitle: "Header & footer links of the public website.",
    columns: [
      { key: "location", label: "Location", render: "code" },
      { key: "label", label: "Label" },
      { key: "href", label: "URL", render: "long" },
      { key: "displayOrder", label: "Order" },
      { key: "isActive", label: "Active", render: "bool" },
    ],
    fields: [
      {
        name: "location",
        label: "Location",
        type: "select",
        required: true,
        options: [
          { value: "HEADER", label: "Header" },
          { value: "FOOTER", label: "Footer" },
        ],
      },
      { name: "label", label: "Label", type: "text", required: true },
      { name: "href", label: "URL", type: "text", required: true, hint: "/path or https://… (no javascript:)" },
      { name: "displayOrder", label: "Display order", type: "number" },
      { name: "isActive", label: "Active", type: "checkbox" },
    ],
  },
};

export const GENERIC_ENTITIES = Object.keys(ENTITY_UI) as Entities[];
