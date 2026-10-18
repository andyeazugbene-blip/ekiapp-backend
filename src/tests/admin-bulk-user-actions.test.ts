/**
 * Bulk user actions (18 Oct 2026 request): suspend/unsuspend/delete many
 * users in one admin-web action. Each method loops the already-tested
 * single-user method (suspendUser/unsuspendUser/deleteUser) and reports
 * per-row outcome — these tests cover the loop/aggregation behavior only,
 * mirroring the existing bulkSuspendVendors pattern.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { adminSuspensionService } from "../modules/admin/admin-suspension.service";
import { adminListingsService } from "../modules/admin/admin-listings.service";

describe("adminSuspensionService.bulkSuspendUsers", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("suspends every user and reports a per-row result, deduping ids", async () => {
    const spy = vi.spyOn(adminSuspensionService, "suspendUser").mockResolvedValue({ user: {} as any, notified: true });
    const input = { reason: "Bulk policy violation", evidence: null, suspendedUntil: null, notifyUser: true };

    const result = await adminSuspensionService.bulkSuspendUsers({ adminId: "admin-1", userIds: ["u1", "u2", "u1"], input });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ affected: 2, results: [{ userId: "u1", ok: true }, { userId: "u2", ok: true }] });
  });

  it("reports a failed row without aborting the rest of the batch", async () => {
    vi.spyOn(adminSuspensionService, "suspendUser")
      .mockResolvedValueOnce({ user: {} as any, notified: true })
      .mockRejectedValueOnce(new Error("User is already suspended"));
    const input = { reason: "Bulk action", evidence: null, suspendedUntil: null, notifyUser: true };

    const result = await adminSuspensionService.bulkSuspendUsers({ adminId: "admin-1", userIds: ["u1", "u2"], input });

    expect(result.affected).toBe(1);
    expect(result.results[1]).toMatchObject({ userId: "u2", ok: false, error: "User is already suspended" });
  });
});

describe("adminSuspensionService.bulkUnsuspendUsers", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("unsuspends every user and reports a per-row result", async () => {
    const spy = vi.spyOn(adminSuspensionService, "unsuspendUser").mockResolvedValue({ user: {} as any, notified: true });
    const result = await adminSuspensionService.bulkUnsuspendUsers({
      adminId: "admin-1", userIds: ["u1", "u2"], input: { reason: "Reviewed and cleared", notifyUser: true },
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.affected).toBe(2);
  });
});

describe("adminListingsService.bulkDeleteUsers", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("deletes every user and reports whether each was hard-deleted or anonymized", async () => {
    vi.spyOn(adminListingsService, "deleteUser")
      .mockResolvedValueOnce({ id: "u1", hardDeleted: true } as any)
      .mockResolvedValueOnce({ id: "u2", hardDeleted: false } as any);

    const result = await adminListingsService.bulkDeleteUsers(["u1", "u2"], "Bulk cleanup");

    expect(result).toEqual({
      affected: 2,
      results: [
        { userId: "u1", ok: true, hardDeleted: true },
        { userId: "u2", ok: true, hardDeleted: false },
      ],
    });
  });

  it("reports a failed row (e.g. admin account) without aborting the batch", async () => {
    vi.spyOn(adminListingsService, "deleteUser")
      .mockResolvedValueOnce({ id: "u1", hardDeleted: true } as any)
      .mockRejectedValueOnce(new Error("Admin accounts cannot be deleted here"));

    const result = await adminListingsService.bulkDeleteUsers(["u1", "admin-1"]);

    expect(result.affected).toBe(1);
    expect(result.results[1]).toMatchObject({ userId: "admin-1", ok: false, error: "Admin accounts cannot be deleted here" });
  });
});
