/**
 * Admin vendor edit previously bypassed the launch-market gate entirely —
 * an admin could set ANY country string on a vendor's PRIMARY market via
 * PATCH /admin/vendors/:id, unlike the vendor-facing onboarding/profile
 * endpoints, which have enforced the 10-approved-launch-markets gate since
 * an earlier pass. This closes that gap: the admin path now shares the same
 * assertApprovedLaunchCountry() gate (unchanged values still grandfathered),
 * and records real before/after state for audit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { adminListingsService } from "../modules/admin/admin-listings.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

describe("adminListingsService.updateVendor — launch-market gate on the primary country", () => {
  const existingVendor = { id: "vendor-1", country: "United Kingdom", currency: "GBP", storeName: "Test Store" };

  it("rejects setting the vendor's country to a market outside the 10 approved launch markets", async () => {
    m.vendor.findUnique.mockResolvedValue(existingVendor as never);

    await expect(
      adminListingsService.updateVendor("vendor-1", { country: "Nigeria" }),
    ).rejects.toThrow(/approved launch markets/i);
    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("allows an unchanged (grandfathered) legacy country to be re-saved without other field changes tripping the gate", async () => {
    const legacyVendor = { id: "vendor-2", country: "Nigeria", currency: "NGN", storeName: "Legacy Store" };
    m.vendor.findUnique.mockResolvedValue(legacyVendor as never);
    m.vendor.update.mockResolvedValue({ ...legacyVendor, description: "Updated" } as never);

    await expect(
      adminListingsService.updateVendor("vendor-2", { country: "Nigeria", description: "Updated" }),
    ).resolves.toBeDefined();
  });

  it("allows moving the primary country to an approved launch market", async () => {
    m.vendor.findUnique.mockResolvedValue(existingVendor as never);
    m.vendor.update.mockResolvedValue({ ...existingVendor, country: "France" } as never);

    const result = await adminListingsService.updateVendor("vendor-1", { country: "France" });
    expect(result.vendor.country).toBe("France");
  });

  it("returns real before/after state for audit — never fabricated", async () => {
    m.vendor.findUnique.mockResolvedValue(existingVendor as never);
    m.vendor.update.mockResolvedValue({ ...existingVendor, country: "France" } as never);

    const result = await adminListingsService.updateVendor("vendor-1", { country: "France" });

    expect(result.before).toEqual({ country: "United Kingdom" });
    expect(result.after).toEqual({ country: "France" });
  });

  it("leaves fields not being changed out of the gate — editing only storeName never touches the country check", async () => {
    m.vendor.findUnique.mockResolvedValue(existingVendor as never);
    m.vendor.update.mockResolvedValue({ ...existingVendor, storeName: "Renamed Store" } as never);

    await expect(
      adminListingsService.updateVendor("vendor-1", { storeName: "Renamed Store" }),
    ).resolves.toBeDefined();
  });
});
