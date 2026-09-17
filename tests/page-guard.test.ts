import { describe, expect, it, vi, beforeAll } from "vitest";
import type { Permission } from "@/lib/rbac";

/* ============================================================
 * Page-level guards.

 * Pages cannot answer 403 the way an API does — they redirect. That makes the
 * redirect the only visible boundary for a staff URL, so it has to be right:
 * agency admins legitimately hold some of the same *permissions* (ai.use,
 * reports.read), and a page that only checks the permission would render a
 * broken screen instead of sending them away.
 * ============================================================ */

const redirects: string[] = [];

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.push(to);
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

vi.mock("@/lib/session", () => ({
  getSessionUser: vi.fn(),
}));

describe("staffActorForPage", () => {
  type ActorFn = (p: Permission, a?: string | null) => Promise<unknown>;
  let staffActorForPage: ActorFn;
  let opActorForPage: (p: Permission) => Promise<unknown>;
  let mockedGetSessionUser: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    ({ staffActorForPage, opActorForPage } = await import("@/lib/page-auth"));
    ({ getSessionUser: mockedGetSessionUser } = (await import("@/lib/session")) as unknown as {
      getSessionUser: ReturnType<typeof vi.fn>;
    });
  });

  const session = (role: string, agencyIds: string[] = []) => ({ id: `u-${role}`, email: `${role.toLowerCase()}@t.test`, role, agencyIds });

  it("sends an agency admin away from a staff page even when they hold the permission", async () => {
    const { can } = await import("@/lib/rbac");
    // Premise, and the reason this test exists: reports.read is shared by the
    // partner role and the back office, so the permission check alone lets an
    // agency admin reach a staff page and fall over inside buildStaffActor.
    expect(can("AGENCY_ADMIN" as never, "reports.read" as never)).toBe(true);
    mockedGetSessionUser.mockResolvedValue(session("AGENCY_ADMIN", ["agency-1"]));
    redirects.length = 0;
    await expect(staffActorForPage("reports.read")).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirects[0]).toBe("/login?error=forbidden");
  });

  it("returns a staff actor for a staff role", async () => {
    mockedGetSessionUser.mockResolvedValue(session("VISA_AGENT"));
    const actor = (await staffActorForPage("ai.use")) as { isStaff: boolean; role: string };
    expect(actor.isStaff).toBe(true);
    expect(actor.role).toBe("VISA_AGENT");
  });

  it("keeps agency portal pages usable for the agency admin", async () => {
    mockedGetSessionUser.mockResolvedValue(session("AGENCY_ADMIN", ["agency-1"]));
    vi.spyOn(await import("@/lib/tenancy"), "resolveAgencyContext").mockResolvedValue("agency-1");
    const actor = (await opActorForPage("applications.read")) as { isStaff: boolean; agencyIds: string[] };
    expect(actor.isStaff).toBe(false);
    expect(actor.agencyIds).toEqual(["agency-1"]);
  });

  it("redirects an anonymous visitor to the sign-in page", async () => {
    mockedGetSessionUser.mockResolvedValue(null);
    redirects.length = 0;
    await expect(staffActorForPage("ai.use")).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirects[0]).toBe("/login");
  });
});
