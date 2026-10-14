/**
 * Vendor-activation spec (12 Oct 2026): "Once verification succeeds, the
 * system must automatically ... publish eligible pending listings without
 * additional vendor action ... notify the vendor only after publication
 * succeeds." These tests guard publishEligibleProducts(), the backbone
 * of that requirement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  vendorFindUnique: vi.fn(),
  deliveryZoneCount: vi.fn(),
  productFindMany: vi.fn(),
  productUpdateMany: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: m.vendorFindUnique },
    deliveryZone: { count: m.deliveryZoneCount },
    product: { findMany: m.productFindMany, updateMany: m.productUpdateMany },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../shared/utils/audit", () => ({ recordAudit: m.recordAudit }));
vi.mock("../modules/events/events.service", () => ({ eventsService: { emit: vi.fn() }, EVENT_NAMES: { product_published: "product_published" } }));
vi.mock("../modules/vendors/vendor-milestone-notifications.service", () => ({
  vendorMilestoneNotificationsService: { maybeSendStoreReady: vi.fn() },
}));

const mockSend = vi.fn().mockResolvedValue({ outcome: "SENT" });
vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: (...a: unknown[]) => mockSend(...a) },
}));

import { vendorActivationService } from "../modules/vendors/vendor-activation.service";

const VENDOR = {
  id: "vendor-1",
  userId: "user-1",
  storeName: "Mama Eki",
  verificationStatus: "VERIFIED",
  contactEmail: "store@test.local",
  user: { email: "owner@test.local" },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.recordAudit.mockResolvedValue(undefined);
  m.vendorFindUnique.mockResolvedValue(VENDOR);
  m.deliveryZoneCount.mockResolvedValue(1);
  m.productFindMany.mockResolvedValue([{ id: "p1", title: "Egusi", images: ["a.jpg"], priceInCents: 500 }]);
  m.productUpdateMany.mockResolvedValue({ count: 1 });
  mockSend.mockResolvedValue({ outcome: "SENT" });
});

describe("vendorActivationService.publishEligibleProducts", () => {
  it("publishes PENDING_ACTIVATION products once verified with a delivery zone, and notifies the vendor only after the DB write commits", async () => {
    const result = await vendorActivationService.publishEligibleProducts("vendor-1");

    expect(result).toEqual({ published: 1 });
    expect(m.productUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { vendorId: "vendor-1", status: "PENDING_ACTIVATION", id: { in: ["p1"] } },
      data: expect.objectContaining({ status: "PUBLISHED", isActive: true }),
    }));
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_store_and_products_live",
      recipientId: "user-1",
    }));
    expect(m.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "VENDOR_PRODUCTS_AUTO_PUBLISHED" }));
  });

  it("does nothing when the vendor isn't verified yet", async () => {
    m.vendorFindUnique.mockResolvedValue({ ...VENDOR, verificationStatus: "PENDING" });

    const result = await vendorActivationService.publishEligibleProducts("vendor-1");

    expect(result).toEqual({ published: 0 });
    expect(m.productUpdateMany).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does nothing when verified but no delivery zone is configured yet — store isn't ready", async () => {
    m.deliveryZoneCount.mockResolvedValue(0);

    const result = await vendorActivationService.publishEligibleProducts("vendor-1");

    expect(result).toEqual({ published: 0 });
    expect(m.productUpdateMany).not.toHaveBeenCalled();
  });

  it("is idempotent — a second call with nothing left to publish does not re-notify", async () => {
    m.productFindMany.mockResolvedValue([]);

    const result = await vendorActivationService.publishEligibleProducts("vendor-1");

    expect(result).toEqual({ published: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never throws into the caller when the DB write fails — logs and lets the next trigger retry", async () => {
    m.productUpdateMany.mockRejectedValue(new Error("db down"));

    const result = await vendorActivationService.publishEligibleProducts("vendor-1");

    expect(result).toEqual({ published: 0 });
    expect(m.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "VENDOR_PRODUCTS_AUTO_PUBLISH_FAILED" }));
  });

  it("loses the race to a concurrent publish (updateMany matches 0 rows) without double-notifying", async () => {
    m.productUpdateMany.mockResolvedValue({ count: 0 });

    const result = await vendorActivationService.publishEligibleProducts("vendor-1");

    expect(result).toEqual({ published: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
