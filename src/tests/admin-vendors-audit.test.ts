/**
 * Audit completeness gap identified by the functional audit: vendor
 * suspend captured a reason, unsuspend didn't. Both now record a real
 * reason (when the admin gives one) plus real before/after state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn(), update: vi.fn() },
    product: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../shared/utils/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn() }));

import { prisma } from "../lib/prisma";
import { recordAudit } from "../shared/utils/audit";
import { adminVendorsService } from "../modules/admin/admin-vendors.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("adminVendorsService.unsuspendVendor — audit completeness fix", () => {
  it("records a real reason and real before/after state, not just an entityId", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", isSuspended: true, suspendedReason: "late deliveries" } as never);
    m.vendor.update.mockResolvedValue({ id: "vendor-1", isSuspended: false, suspendedReason: null } as never);

    await adminVendorsService.unsuspendVendor("admin-1", "vendor-1", "appeal upheld");

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "vendor.unsuspend",
        reason: "appeal upheld",
        beforeState: { isSuspended: true, suspendedReason: "late deliveries" },
        afterState: { isSuspended: false, suspendedReason: null },
      }),
    );
  });

  it("still works with no reason given — reason is undefined, never fabricated", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-2", isSuspended: true, suspendedReason: null } as never);
    m.vendor.update.mockResolvedValue({ id: "vendor-2", isSuspended: false, suspendedReason: null } as never);

    await adminVendorsService.unsuspendVendor("admin-1", "vendor-2");

    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ reason: undefined }));
  });
});

describe("adminVendorsService.suspendVendor — real before/after state", () => {
  it("records the vendor's real prior (unsuspended) state alongside the new one", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-3", isSuspended: false, suspendedReason: null } as never);
    m.vendor.update.mockResolvedValue({ id: "vendor-3", isSuspended: true, suspendedReason: "fraud report" } as never);
    m.product.updateMany.mockResolvedValue({ count: 0 } as never);

    await adminVendorsService.suspendVendor("admin-1", "vendor-3", "fraud report");

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "vendor.suspend",
        reason: "fraud report",
        beforeState: { isSuspended: false, suspendedReason: null },
        afterState: { isSuspended: true, suspendedReason: "fraud report" },
      }),
    );
  });
});
