import { eq } from "drizzle-orm";
import { getDb, users } from "@/db";
import type { OpActor } from "@/lib/guard";
import { DomainError } from "@/lib/ops";

export const SYSTEM_EMAIL = "automation@essafaria.local";

/* ============================================================
 * The SYSTEM actor for scheduled work.
 *
 * Two design points:
 *   • It maps to a REAL, deactivated user row (created by the seed) so audit
 *     rows satisfy the actor FK and the trail shows exactly which automation
 *     wrote them — while `isActive = false` means the account cannot log in and
 *     is never picked up as a notification recipient (it would notify itself).
 *   • Its role is VISA_AGENT, deliberately: the desk role may read cases, remind
 *     people and run sweeps, but has no wallet, pricing, configuration or
 *     review capability. A cron job therefore cannot become a way around a
 *     human decision, even if a task were written badly.
 * ============================================================ */
export async function systemActor(): Promise<OpActor> {
  const t = (await getDb()) as unknown as {
    select: (v: unknown) => { from: (t: unknown) => { where: (c: unknown) => { limit: (n: number) => Promise<Array<{ id: string; role: string }>> } } };
  };
  const rows = await t.select({ id: users.id, role: users.role }).from(users).where(eq(users.email, SYSTEM_EMAIL)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new DomainError(
      "CONFIG",
      `The system account (${SYSTEM_EMAIL}) is missing — run \`npm run db:seed\` to create it`,
    );
  }
  return {
    id: row.id,
    email: SYSTEM_EMAIL,
    role: row.role as OpActor["role"],
    isStaff: true,
    agencyIds: [],
    actingAgencyId: null,
    mayCreateForAgency: false,
    // no money, no config, no verdicts
    mayCharge: false,
  };
}
