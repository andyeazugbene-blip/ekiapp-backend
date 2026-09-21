/**
 * Phase 4.2 (test coverage for already-implemented features) — vendor
 * weight-based shipping (delivery-zone/method) CRUD was real, working, and
 * wired to a real mobile screen, but had zero dedicated test coverage.
 * This exercises: currency is always derived from country server-side
 * (never trusts a client-supplied value), and cross-vendor ownership is
 * enforced on every mutation, including the nested delivery-method
 * mutations (which check ownership via the parent zone).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn() },
    deliveryZone: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findMany: vi.fn() },
    deliveryMethod: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { deliveryZonesService } from "../modules/delivery/delivery-zones.service";

const m = vi.mocked(prisma, true) as any;
const VENDOR = { id: "vendor-1" };

beforeEach(() => vi.clearAllMocks());

describe("createVendorZone — currency is always derived from country server-side", () => {
  it("derives GBP for United Kingdom regardless of what the client might have sent", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.create.mockResolvedValue({ id: "zone-1", currency: "GBP" });

    await deliveryZonesService.createVendorZone("user-1", {
      name: "UK zone", country: "United Kingdom", flag: "🇬🇧", baseFeeAmount: 500, feePerKgAmount: 100,
    } as any);

    expect(m.deliveryZone.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ country: "United Kingdom", currency: "GBP" }),
    }));
  });

  it("403s without a vendor profile", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(
      deliveryZonesService.createVendorZone("user-1", { name: "x", country: "United Kingdom", flag: "x", baseFeeAmount: 1, feePerKgAmount: 1 } as any),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(m.deliveryZone.create).not.toHaveBeenCalled();
  });
});

describe("updateVendorZone — ownership + currency re-derivation", () => {
  it("404s for a zone that doesn't exist", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue(null);
    await expect(deliveryZonesService.updateVendorZone("user-1", "zone-x", {} as any)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("403s when the zone belongs to a different vendor", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue({ id: "zone-1", vendorId: "someone-elses-vendor" });
    await expect(deliveryZonesService.updateVendorZone("user-1", "zone-1", { name: "new" } as any)).rejects.toMatchObject({ statusCode: 403 });
    expect(m.deliveryZone.update).not.toHaveBeenCalled();
  });

  it("re-derives currency when the country changes, ignoring any client-supplied currency", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue({ id: "zone-1", vendorId: "vendor-1", country: "United Kingdom" });
    m.deliveryZone.update.mockResolvedValue({ id: "zone-1", currency: "USD" });

    await deliveryZonesService.updateVendorZone("user-1", "zone-1", { country: "United States", currency: "GBP" } as any);

    expect(m.deliveryZone.update).toHaveBeenCalledWith({
      where: { id: "zone-1" },
      data: expect.objectContaining({ country: "United States", currency: "USD" }),
    });
  });

  it("leaves currency alone when country isn't part of the update", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue({ id: "zone-1", vendorId: "vendor-1", country: "United Kingdom" });
    m.deliveryZone.update.mockResolvedValue({});

    await deliveryZonesService.updateVendorZone("user-1", "zone-1", { name: "Renamed" } as any);

    expect(m.deliveryZone.update).toHaveBeenCalledWith({
      where: { id: "zone-1" },
      data: expect.not.objectContaining({ currency: expect.anything() }),
    });
  });
});

describe("deleteVendorZone — ownership enforced", () => {
  it("403s when deleting a zone that belongs to a different vendor", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue({ id: "zone-1", vendorId: "someone-elses-vendor" });
    await expect(deliveryZonesService.deleteVendorZone("user-1", "zone-1")).rejects.toMatchObject({ statusCode: 403 });
    expect(m.deliveryZone.delete).not.toHaveBeenCalled();
  });

  it("deletes a zone the vendor actually owns", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue({ id: "zone-1", vendorId: "vendor-1" });
    m.deliveryZone.delete.mockResolvedValue({});

    await deliveryZonesService.deleteVendorZone("user-1", "zone-1");

    expect(m.deliveryZone.delete).toHaveBeenCalledWith({ where: { id: "zone-1" } });
  });
});

describe("addMethod — ownership + minDays/maxDays validation", () => {
  it("403s when the zone belongs to a different vendor", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue({ id: "zone-1", vendorId: "someone-elses-vendor" });
    await expect(
      deliveryZonesService.addMethod("user-1", "zone-1", { label: "Standard", priceAmount: 500, minDays: 2, maxDays: 5 } as any),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(m.deliveryMethod.create).not.toHaveBeenCalled();
  });

  it("rejects minDays greater than maxDays", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue({ id: "zone-1", vendorId: "vendor-1" });
    await expect(
      deliveryZonesService.addMethod("user-1", "zone-1", { label: "Standard", priceAmount: 500, minDays: 10, maxDays: 5 } as any),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(m.deliveryMethod.create).not.toHaveBeenCalled();
  });

  it("creates a method for a zone the vendor genuinely owns", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findUnique.mockResolvedValue({ id: "zone-1", vendorId: "vendor-1" });
    m.deliveryMethod.create.mockResolvedValue({ id: "method-1" });

    await deliveryZonesService.addMethod("user-1", "zone-1", { label: "Standard", priceAmount: 500, minDays: 2, maxDays: 5 } as any);

    expect(m.deliveryMethod.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveryZoneId: "zone-1", label: "Standard" }),
    }));
  });
});

describe("updateMethod / deleteMethod — ownership checked via the parent zone", () => {
  it("updateMethod 403s when the method's zone belongs to a different vendor", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryMethod.findUnique.mockResolvedValue({ id: "method-1", deliveryZone: { vendorId: "someone-elses-vendor" } });
    await expect(deliveryZonesService.updateMethod("user-1", "method-1", { priceAmount: 999 } as any)).rejects.toMatchObject({ statusCode: 403 });
    expect(m.deliveryMethod.update).not.toHaveBeenCalled();
  });

  it("updateMethod 404s for a method that doesn't exist", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryMethod.findUnique.mockResolvedValue(null);
    await expect(deliveryZonesService.updateMethod("user-1", "missing", {} as any)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("deleteMethod 403s when the method's zone belongs to a different vendor", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryMethod.findUnique.mockResolvedValue({ id: "method-1", deliveryZone: { vendorId: "someone-elses-vendor" } });
    await expect(deliveryZonesService.deleteMethod("user-1", "method-1")).rejects.toMatchObject({ statusCode: 403 });
    expect(m.deliveryMethod.delete).not.toHaveBeenCalled();
  });

  it("deleteMethod succeeds for a method the vendor genuinely owns (via its zone)", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryMethod.findUnique.mockResolvedValue({ id: "method-1", deliveryZone: { vendorId: "vendor-1" } });
    m.deliveryMethod.delete.mockResolvedValue({});

    await deliveryZonesService.deleteMethod("user-1", "method-1");

    expect(m.deliveryMethod.delete).toHaveBeenCalledWith({ where: { id: "method-1" } });
  });
});

describe("listVendorZones — scoped to the requesting vendor only", () => {
  it("queries deliveryZone by this vendor's own id", async () => {
    m.vendor.findUnique.mockResolvedValue(VENDOR);
    m.deliveryZone.findMany.mockResolvedValue([]);

    await deliveryZonesService.listVendorZones("user-1");

    expect(m.deliveryZone.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { vendorId: "vendor-1" } }));
  });
});
