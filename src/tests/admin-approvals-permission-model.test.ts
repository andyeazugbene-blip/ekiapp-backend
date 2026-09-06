import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    adminRole: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminRolesService, ADMIN_PERMISSIONS } from "../modules/admin/admin-roles.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

/**
 * Regression coverage for the four-eyes permission-model fix: GET /approvals
 * and POST /approvals/:id/decide used to be gated on roles.read/roles.mutate,
 * which none of the operational default roles hold — meaning only a Super
 * Administrator could ever decide an approval, defeating role-scoped
 * four-eyes. Fixed by introducing dedicated approvals.read/approvals.decide
 * permissions and granting them to the roles whose own mutate permissions
 * actually trigger four-eyes gating.
 */
describe("admin permission model — approvals.read / approvals.decide", () => {
  it("ADMIN_PERMISSIONS includes the new approvals permissions", () => {
    expect(ADMIN_PERMISSIONS).toContain("approvals.read");
    expect(ADMIN_PERMISSIONS).toContain("approvals.decide");
  });

  async function seededPermissionsFor(roleName: string): Promise<string[]> {
    m.adminRole.findUnique.mockResolvedValue(null);
    await adminRolesService.seedDefaultRoles();
    const call = m.adminRole.create.mock.calls.find(([args]: any) => args.data.name === roleName);
    expect(call, `expected seedDefaultRoles to create a role named "${roleName}"`).toBeTruthy();
    return call![0].data.permissions;
  }

  it.each([
    "Refund Operations",
    "Payment Operations",
    "Campaign Reviewer",
    "Supplier Settlement",
  ])("%s — an operational role that can trigger four-eyes — can read and decide approvals", async (roleName) => {
    const permissions = await seededPermissionsFor(roleName);
    expect(permissions).toContain("approvals.read");
    expect(permissions).toContain("approvals.decide");
  });

  it("Read-Only Auditor gets approvals.read (via the blanket .read grant) but never approvals.decide", async () => {
    const permissions = await seededPermissionsFor("Read-Only Auditor");
    expect(permissions).toContain("approvals.read");
    expect(permissions).not.toContain("approvals.decide");
  });

  it("Verification Reviewer and Risk / Fraud — roles with no four-eyes-gated action — get neither approvals permission", async () => {
    for (const roleName of ["Verification Reviewer", "Risk / Fraud"]) {
      const permissions = await seededPermissionsFor(roleName);
      expect(permissions).not.toContain("approvals.read");
      expect(permissions).not.toContain("approvals.decide");
    }
  });
});

/**
 * Regression coverage for the orders.read gap: Refund Operations and Payment
 * Operations could execute payments.mutate actions (refund an order, act on
 * a payout) but had no way to look up the order/payment through the real
 * admin API first — orders.read gates GET /orders, /orders/:id, /payments,
 * /wallet-transactions and /refunds. Fixed by granting orders.read to both.
 */
describe("admin permission model — orders.read for payment-adjacent roles", () => {
  async function seededPermissionsFor(roleName: string): Promise<string[]> {
    m.adminRole.findUnique.mockResolvedValue(null);
    await adminRolesService.seedDefaultRoles();
    const call = m.adminRole.create.mock.calls.find(([args]: any) => args.data.name === roleName);
    return call![0].data.permissions;
  }

  it.each(["Refund Operations", "Payment Operations"])(
    "%s can view the orders/payments it acts on",
    async (roleName) => {
      const permissions = await seededPermissionsFor(roleName);
      expect(permissions).toContain("orders.read");
    },
  );
});
