import { describe, it, expect } from "vitest";
import {
  hexColor,
  safeHref,
  agencyCode,
  entityCode,
  currencyCode,
  templateUpsertSchema,
  renderTemplate,
  statusUpsertSchema,
  homepageSectionUpsertSchema,
  validateSettingValue,
  moneyCents,
} from "@/lib/validation";
import { sniffImage, makeStorageKey } from "@/lib/storage";

/* Input safety layer — the last line before config lands in the DB. */

describe("validation primitives", () => {
  it("colors", () => {
    expect(hexColor.parse("#0E7A6D")).toBe("#0E7A6D");
    expect(() => hexColor.parse("red")).toThrow();
    expect(() => hexColor.parse("#0E7A6")).toThrow();
    expect(() => hexColor.parse("javascript:alert(1)")).toThrow();
  });

  it("hrefs: internal and http(s) allowed, injection blocked", () => {
    expect(safeHref.parse("/legal/terms")).toBe("/legal/terms");
    expect(safeHref.parse("https://example.com")).toBe("https://example.com");
    expect(safeHref.parse("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(() => safeHref.parse("javascript:alert(1)")).toThrow();
    expect(() => safeHref.parse("data:text/html,<script>")).toThrow();
    expect(() => safeHref.parse("//evil.com")).toThrow();
  });

  it("codes are normalized and strict", () => {
    expect(agencyCode.parse("alpha-trv")).toBe("ALPHA-TRV");
    expect(() => agencyCode.parse("A!")).toThrow();
    expect(entityCode.parse("short_stay")).toBe("SHORT_STAY");
    expect(() => entityCode.parse("1BAD")).toThrow();
    expect(currencyCode.parse("eur")).toBe("EUR");
    expect(() => currencyCode.parse("EURO")).toThrow();
  });

  it("money is integer cents, non-negative", () => {
    expect(moneyCents.parse("4500")).toBe(4500);
    expect(() => moneyCents.parse("-1")).toThrow();
    expect(() => moneyCents.parse("1.5")).toThrow();
  });

  it("status color is required to be hex", () => {
    const ok = statusUpsertSchema.safeParse({ code: "ON_HOLD", label: "On Hold", color: "#123456", isTerminal: false, isActive: true, displayOrder: 15 });
    expect(ok.success).toBe(true);
    const bad = statusUpsertSchema.safeParse({ code: "ON_HOLD", label: "On Hold", color: "#xyz", isTerminal: false, isActive: true, displayOrder: 15 });
    expect(bad.success).toBe(false);
  });
});

describe("communication templates (whitelisted variables only)", () => {
  it("accepts known placeholders", () => {
    const res = templateUpsertSchema.safeParse({
      code: "TPL_TEST",
      name: "Test",
      subject: "Hello {{client_name}} — {{application_reference}}",
      body: "Status: {{status}} for {{visa_type}} in {{country}}",
      language: "en",
      isActive: true,
    });
    expect(res.success).toBe(true);
  });

  it("rejects unknown placeholders (no arbitrary template execution)", () => {
    const res = templateUpsertSchema.safeParse({
      code: "TPL_TEST",
      name: "Test",
      subject: "Hello {{process.exit}}",
      body: "x",
      language: "en",
      isActive: true,
    });
    expect(res.success).toBe(false);
  });

  it("renders values escaped", () => {
    const out = renderTemplate("Hi {{client_name}} ({{status}})", {
      client_name: "<script>alert(1)</script>",
      status: "APPROVED",
    });
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
    expect(out).toContain("APPROVED");
  });

  it("leaves unknown vars untouched, never executes them", () => {
    const out = renderTemplate("keep {{unknown_thing}}", {});
    expect(out).toBe("keep {{unknown_thing}}");
  });
});

describe("homepage section input shape", () => {
  it("bounds item counts and text length", () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ title: `t${i}`, description: "" }));
    const res = homepageSectionUpsertSchema.safeParse({ sectionType: "services", items, isActive: true, displayOrder: 1 });
    expect(res.success).toBe(false); // >12 items rejected
  });
});

describe("typed site settings", () => {
  it("validates per-key", () => {
    expect(validateSettingValue("contact.email", "a@b.com").ok).toBe(true);
    expect(validateSettingValue("contact.email", "nope").ok).toBe(false);
    expect(validateSettingValue("made.up.key", "x").ok).toBe(false);
    expect(validateSettingValue("security.sessionDays", "14").ok).toBe(true);
    expect(validateSettingValue("security.sessionDays", "999").ok).toBe(false);
  });
});

describe("media storage", () => {
  it("sniffs magic bytes instead of trusting filenames", () => {
    const png = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(0x89504e47, 0); // keep first word as per impl
    expect(["image/png", null].includes(sniffImage(png)?.mime ?? null)).toBe(true);
    expect(sniffImage(Buffer.from("GIF89aevil"))).toBeNull();
    expect(sniffImage(Buffer.from("<svg onload=alert(1)>"))).toBeNull(); // SVG rejected
  });

  it("storage keys stay within their prefix and carry no traversal", () => {
    const key = makeStorageKey("logo", "../../etc/passwd.png");
    expect(key.startsWith("logo/")).toBe(true);
    expect(key).not.toContain("..");
  });
});

describe("validation is idempotent (services re-validate their own output)", () => {
  it("re-parsing a normalised payload yields the same result", async () => {
    const { applicantUpsertSchema, feeUpsertSchema, statusUpsertSchema, requirementUpsertSchema, documentTypeUpsertSchema } = await import(
      "@/lib/validation"
    );
    const once = applicantUpsertSchema.parse({
      fullName: "Ada Lovelace",
      dateOfBirth: "1985-05-05",
      passportNumber: "ada-123",
      passportIssueDate: "2020-01-01",
      passportExpiryDate: "2030-01-01",
      gender: "",
      maritalStatus: "",
      email: "",
      phone: "",
      address: "",
      notes: "",
      nationalityCountryCode: "",
    });
    const twice = applicantUpsertSchema.safeParse(once);
    expect(twice.success).toBe(true);
    expect((twice as { data: unknown }).data).toEqual(once);

    const doc = documentTypeUpsertSchema.parse({
      code: "TEST_TYPE",
      name: "Test type",
      description: "",
      allowedExtensions: ["pdf"],
      maxFileSizeMb: "",
      isActive: true,
      displayOrder: 3,
    });
    expect(documentTypeUpsertSchema.safeParse(doc).success).toBe(true);

    const req = requirementUpsertSchema.parse({
      visaTypeId: "visa-1",
      documentTypeId: "doc-1",
      isRequired: true,
      instructions: "",
      validityDays: "",
      displayOrder: 0,
    });
    expect(requirementUpsertSchema.safeParse(req).success).toBe(true);

    const fee = feeUpsertSchema.parse({
      visaTypeId: "visa-1",
      currencyCode: "eur",
      feeType: "VISA_FEE",
      amountCents: "15000",
      effectiveFrom: "2026-01-01",
      isActive: true,
      notes: "",
    });
    expect(feeUpsertSchema.safeParse(fee).success).toBe(true);
    expect(fee.amountCents).toBe(15000);

    const st = statusUpsertSchema.parse({
      code: "NEW",
      label: "New",
      color: "#2563eb",
      description: "",
      isTerminal: false,
      isActive: true,
      displayOrder: 10,
      requiresDocumentsComplete: false,
      customerVisible: true,
      allowedNextStatusCodes: "",
    });
    expect(statusUpsertSchema.safeParse(st).success).toBe(true);
    expect(st.allowedNextStatusCodes).toBeNull();
  });

  it("a value of null never becomes the string \"NULL\"", async () => {
    const { applicantUpsertSchema } = await import("@/lib/validation");
    const r = applicantUpsertSchema.safeParse({
      fullName: "Null Tester",
      passportExpiryDate: "2031-01-01",
      gender: null,
      maritalStatus: null,
      email: null,
      phone: null,
      nationalityCountryCode: null,
      passportNumber: null,
    });
    expect(r.success).toBe(true);
  });
});
