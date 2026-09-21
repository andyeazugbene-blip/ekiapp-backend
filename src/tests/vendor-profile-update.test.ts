/**
 * Phase 4.2 (test coverage for already-implemented features) — vendor
 * business/store profile editing (updateOwnVendor in vendors.service.ts)
 * was real, working, and wired to a real mobile screen, but had zero
 * dedicated test coverage. Exercises the real correctness properties:
 * country changes are gated to the approved launch markets (but an
 * unchanged country is always allowed, even if it predates the gate — no
 * existing account gets locked out), store-name-availability is checked
 * only when the name actually changes (case-insensitively), and a
 * race-condition unique-constraint hit is mapped to a clean 409 instead of
 * a raw Prisma error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { vendorsService } from "../modules/vendors/vendors.service";

const m = vi.mocked(prisma, true) as any;

const EXISTING_VENDOR = { id: "vendor-1", userId: "user-1", storeName: "My Store", country: "United Kingdom" };

beforeEach(() => vi.clearAllMocks());

describe("updateOwnVendor — country gated to approved launch markets", () => {
  it("404s when the caller has no vendor profile", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(vendorsService.updateOwnVendor("user-1", { country: "United Kingdom" } as any)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects changing country to a market that isn't approved", async () => {
    m.vendor.findUnique.mockResolvedValue(EXISTING_VENDOR);
    await expect(vendorsService.updateOwnVendor("user-1", { country: "Nigeria" } as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("allows changing country to an approved market", async () => {
    m.vendor.findUnique.mockResolvedValue(EXISTING_VENDOR);
    m.vendor.update.mockResolvedValue({ ...EXISTING_VENDOR, country: "United States" });

    await vendorsService.updateOwnVendor("user-1", { country: "United States" } as any);

    expect(m.vendor.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "vendor-1" } }));
  });

  it("re-saving the SAME country never gets blocked, even if it's outside the approved set (grandfathered accounts)", async () => {
    const grandfathered = { ...EXISTING_VENDOR, country: "Nigeria" };
    m.vendor.findUnique.mockResolvedValue(grandfathered);
    m.vendor.update.mockResolvedValue(grandfathered);

    await vendorsService.updateOwnVendor("user-1", { country: "Nigeria", storeName: "My Store" } as any);

    expect(m.vendor.update).toHaveBeenCalled();
  });
});

describe("updateOwnVendor — store-name availability", () => {
  it("checks availability only when the name actually changes, and rejects a name already taken", async () => {
    m.vendor.findUnique.mockResolvedValue(EXISTING_VENDOR);
    m.vendor.findFirst.mockResolvedValue({ id: "some-other-vendor" }); // name taken

    await expect(vendorsService.updateOwnVendor("user-1", { storeName: "Someone Else's Store" } as any)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.vendor.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ storeName: { equals: "Someone Else's Store", mode: "insensitive" } }),
    }));
    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("skips the availability check entirely when the name is unchanged (case-insensitively)", async () => {
    m.vendor.findUnique.mockResolvedValue(EXISTING_VENDOR);
    m.vendor.update.mockResolvedValue(EXISTING_VENDOR);

    await vendorsService.updateOwnVendor("user-1", { storeName: "MY STORE" } as any); // same name, different case

    expect(m.vendor.findFirst).not.toHaveBeenCalled();
    expect(m.vendor.update).toHaveBeenCalled();
  });

  it("allows a genuinely available new name", async () => {
    m.vendor.findUnique.mockResolvedValue(EXISTING_VENDOR);
    m.vendor.findFirst.mockResolvedValue(null); // available
    m.vendor.update.mockResolvedValue({ ...EXISTING_VENDOR, storeName: "New Store Name" });

    await vendorsService.updateOwnVendor("user-1", { storeName: "New Store Name" } as any);

    expect(m.vendor.update).toHaveBeenCalled();
  });

  it("maps a race-condition unique-constraint violation on the actual write to a clean 409", async () => {
    m.vendor.findUnique.mockResolvedValue(EXISTING_VENDOR);
    m.vendor.findFirst.mockResolvedValue(null); // passed the availability check...
    // ...but another request took the name microseconds later:
    m.vendor.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.0.0", meta: { target: ["storeName"] } }),
    );

    await expect(vendorsService.updateOwnVendor("user-1", { storeName: "Racing Name" } as any)).rejects.toMatchObject({ statusCode: 409 });
  });
});
