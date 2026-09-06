/**
 * applyAsSupplier's real-market cross-check: a vendor may apply as a
 * Community Buy supplier only for a market they actually have an active
 * VendorMarketAssignment for. Previously this application was completely
 * decoupled from the vendor's own markets — a vendor operating only in the
 * UK could apply to supply France's Community Buy just by sending a
 * different country string.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    supplierProfile: { findUnique: vi.fn(), create: vi.fn() },
    vendorMarketAssignment: { findUnique: vi.fn() },
  },
}));

vi.mock("../modules/community-buy/market-configuration.service", () => ({
  marketConfigurationService: { get: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { marketConfigurationService } from "../modules/community-buy/market-configuration.service";
import { organiserSupplierService } from "../modules/community-buy/organiser-supplier.service";

const m = vi.mocked(prisma, true);
const getMarketConfig = vi.mocked(marketConfigurationService.get);

beforeEach(() => {
  vi.clearAllMocks();
  getMarketConfig.mockResolvedValue({ supplierApplicationsEnabled: true } as never);
  m.vendor.findUnique.mockResolvedValue({ verificationStatus: "VERIFIED" } as never);
  m.supplierProfile.findUnique.mockResolvedValue(null as never);
});

describe("organiserSupplierService.applyAsSupplier — vendor must be assigned to the exact market applied for", () => {
  it("rejects applying for a market the vendor has no active assignment for", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue(null as never);

    await expect(
      organiserSupplierService.applyAsSupplier("vendor-1", "France"),
    ).rejects.toThrow(/assigned to/i);
    expect(m.supplierProfile.create).not.toHaveBeenCalled();
  });

  it("rejects applying for a market where the vendor's assignment exists but is disabled", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ enabled: false } as never);

    await expect(
      organiserSupplierService.applyAsSupplier("vendor-1", "France"),
    ).rejects.toThrow(/assigned to/i);
  });

  it("allows applying for a market the vendor has an active assignment for", async () => {
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ enabled: true } as never);
    m.supplierProfile.create.mockResolvedValue({ id: "sup-1", vendorId: "vendor-1", country: "France" } as never);

    await organiserSupplierService.applyAsSupplier("vendor-1", "France");

    expect(m.supplierProfile.create).toHaveBeenCalledWith({ data: { vendorId: "vendor-1", country: "France" } });
  });

  it("a two-market vendor (UK + France) can apply for EITHER market independently", async () => {
    m.vendorMarketAssignment.findUnique.mockImplementation(async ({ where }: any) => {
      const code = where.vendorId_marketCode.marketCode;
      return (code === "GB" || code === "FR") ? { enabled: true } : null;
    });
    m.supplierProfile.create.mockResolvedValue({} as never);

    await expect(organiserSupplierService.applyAsSupplier("vendor-1", "United Kingdom")).resolves.toBeDefined();
  });

  it("still enforces market-level supplierApplicationsEnabled even when the vendor is correctly assigned", async () => {
    getMarketConfig.mockResolvedValue({ supplierApplicationsEnabled: false } as never);
    m.vendorMarketAssignment.findUnique.mockResolvedValue({ enabled: true } as never);

    await expect(
      organiserSupplierService.applyAsSupplier("vendor-1", "France"),
    ).rejects.toThrow(/not open in this market/i);
    expect(m.supplierProfile.create).not.toHaveBeenCalled();
  });
});
