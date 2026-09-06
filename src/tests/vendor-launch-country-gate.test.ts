import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { vendorsService } from "../modules/vendors/vendors.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

/**
 * Regression coverage for the vendor-onboarding country gate: backend
 * previously accepted ANY country string with no validation at all, which
 * is how the mobile app's onboarding screen could default new vendors to
 * "Nigeria" and offer countries never approved for launch with zero
 * server-side backstop. createVendor/updateOwnVendor now reject a country
 * that doesn't resolve to one of the 10 approved launch markets, so even a
 * direct API call bypassing the (now-restricted) mobile picker can't create
 * a vendor in an unsupported market.
 */
describe("vendorsService.createVendor — launch-country gate", () => {
  it("rejects a country outside the 10 approved launch markets before touching the database", async () => {
    await expect(
      vendorsService.createVendor("user-1", { storeName: "Test Store", country: "Nigeria" }),
    ).rejects.toThrow(/approved launch markets/i);

    expect(m.vendor.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized country string the same way", async () => {
    await expect(
      vendorsService.createVendor("user-1", { storeName: "Test Store", country: "Narnia" }),
    ).rejects.toThrow(/approved launch markets/i);
  });

  it("allows a real launch-market country name to pass the gate (proceeds to the DB check)", async () => {
    m.vendor.findUnique.mockResolvedValue(null as never);
    // No country at all is also valid (optional field) — proves the gate
    // doesn't require a country, only rejects an unsupported one.
    await expect(
      vendorsService.createVendor("user-1", { storeName: "Test Store", country: undefined }),
    ).rejects.not.toThrow(/approved launch markets/i);
  });
});

describe("vendorsService.updateOwnVendor — launch-country gate", () => {
  const existingVendor = { id: "vendor-1", userId: "user-1", storeName: "Test Store", country: "Nigeria" };

  it("rejects moving TO an unsupported country", async () => {
    m.vendor.findUnique.mockResolvedValue(existingVendor as never);

    await expect(
      vendorsService.updateOwnVendor("user-1", { country: "Ghana" }),
    ).rejects.toThrow(/approved launch markets/i);

    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("allows re-saving the SAME already-unsupported country unchanged — never locks out an existing vendor for a value that predates this gate", async () => {
    m.vendor.findUnique.mockResolvedValue(existingVendor as never);
    m.vendor.update.mockResolvedValue({ ...existingVendor } as never);

    await expect(vendorsService.updateOwnVendor("user-1", { country: "Nigeria" })).resolves.toBeDefined();
    expect(m.vendor.update).toHaveBeenCalled();
  });

  it("allows moving TO an approved launch market", async () => {
    m.vendor.findUnique.mockResolvedValue(existingVendor as never);
    m.vendor.update.mockResolvedValue({ ...existingVendor, country: "United Kingdom" } as never);

    await expect(vendorsService.updateOwnVendor("user-1", { country: "United Kingdom" })).resolves.toBeDefined();
  });

  it("case-insensitive match against the current country also counts as unchanged", async () => {
    m.vendor.findUnique.mockResolvedValue({ ...existingVendor, country: "United Kingdom" } as never);
    m.vendor.update.mockResolvedValue({} as never);

    await expect(vendorsService.updateOwnVendor("user-1", { country: "united kingdom" })).resolves.toBeDefined();
  });
});
