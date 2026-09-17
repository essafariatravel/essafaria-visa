import { describe, it, expect } from "vitest";
import { can, ROLE_PERMISSIONS, PERMISSIONS, assertPermission } from "@/lib/rbac";

/* RBAC matrix — server-side truth for every capability decision. */

describe("role → capability matrix", () => {
  it("agency users can access the portal but never platform configuration", () => {
    expect(can("AGENCY_USER", "agency_portal.access")).toBe(true);
    expect(can("AGENCY_USER", "countries.write")).toBe(false);
    expect(can("AGENCY_USER", "visa_types.write")).toBe(false);
    expect(can("AGENCY_USER", "branding.write")).toBe(false);
    expect(can("AGENCY_USER", "pricing.write")).toBe(false);
    expect(can("AGENCY_USER", "audit_logs.read")).toBe(false);
  });

  it("agency admins manage their agency's users but not the platform", () => {
    expect(can("AGENCY_ADMIN", "agencies.users.manage")).toBe(true);
    expect(can("AGENCY_ADMIN", "countries.write")).toBe(false);
    expect(can("AGENCY_ADMIN", "agencies.write")).toBe(false);
    expect(can("AGENCY_ADMIN", "settings.write")).toBe(false);
  });

  it("visa agents operate the catalog but cannot touch site/branding writes", () => {
    expect(can("VISA_AGENT", "visa_types.write")).toBe(true);
    expect(can("VISA_AGENT", "visa_requirements.write")).toBe(true);
    expect(can("VISA_AGENT", "branding.write")).toBe(false);
    expect(can("VISA_AGENT", "navigation.write")).toBe(false);
    expect(can("VISA_AGENT", "settings.write")).toBe(false);
    expect(can("VISA_AGENT", "users.write")).toBe(false);
  });

  it("accounting owns pricing/currencies only", () => {
    expect(can("ACCOUNTING", "pricing.write")).toBe(true);
    expect(can("ACCOUNTING", "currencies.write")).toBe(true);
    expect(can("ACCOUNTING", "visa_types.write")).toBe(false);
    expect(can("ACCOUNTING", "content.write")).toBe(false);
  });

  it("admin covers business configuration", () => {
    for (const p of ["countries.write", "statuses.write", "branding.write", "pricing.write", "audit_logs.read"] as const) {
      expect(can("ADMIN", p)).toBe(true);
    }
  });

  it("super admin holds every declared permission", () => {
    for (const p of PERMISSIONS) expect(can("SUPER_ADMIN", p)).toBe(true);
  });

  it("every role grants only declared permissions", () => {
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      for (const p of ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS]) {
        expect(PERMISSIONS).toContain(p);
      }
    }
  });

  it("assertPermission throws for missing capabilities", () => {
    expect(() => assertPermission("AGENCY_USER", "countries.write")).toThrow();
    expect(() => assertPermission("SUPER_ADMIN", "countries.write")).not.toThrow();
  });
});
