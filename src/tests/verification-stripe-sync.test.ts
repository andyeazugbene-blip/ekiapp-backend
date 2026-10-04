import { describe, it, expect, vi, beforeEach } from "vitest";

// The admin Verification Review page's own subtitle used to admit the bug:
// "New vendors verify via Stripe Identity. Legacy document submissions
// shown below for review." — adminListReviewQueue() only ever surfaced
// vendors with an uploaded VerificationDocument row, but no screen in the
// app has called submitVerificationDocument() since Stripe Identity
// shipped (see (vendor-verification)/index.tsx — it's 100% Stripe-driven).
// Every real vendor's verification was therefore invisible to admin: no
// way to see it, audit it, or override it. These tests guard the fix —
// Stripe Identity attempts are now first-class in the same queue.
vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    verificationDocument: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));
vi.mock("../lib/storage", () => ({
  generatePresignedRead: vi.fn(async (key: string) => `https://signed/${key}`),
  deleteStoredObject: vi.fn(async () => undefined),
}));
vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: vi.fn(async () => undefined) },
}));

import { prisma } from "../lib/prisma";
import { verificationService } from "../modules/verification/verification.service";

const m = vi.mocked(prisma, true);

beforeEach(() => vi.clearAllMocks());

function vendorRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "v1",
    storeName: "Queen Foods",
    contactEmail: null,
    contactPhone: null,
    verificationStatus: "PENDING",
    createdAt: new Date("2026-01-01"),
    stripeVerificationSessionId: null,
    verifiedAt: null,
    verificationFailureReason: null,
    user: { name: "Amara", email: "amara@example.com", phone: null },
    ...overrides,
  };
}

describe("adminListReviewQueue — Stripe Identity attempts are visible, not just document uploads", () => {
  it("includes a vendor who verified via Stripe Identity and has zero uploaded documents", async () => {
    m.vendor.findMany.mockResolvedValue([
      vendorRow({ id: "stripe-vendor", stripeVerificationSessionId: "vs_123", verificationStatus: "VERIFIED", verifiedAt: new Date("2026-02-01") }),
    ] as never);
    m.verificationDocument.findMany.mockResolvedValue([] as never);

    const result = await verificationService.adminListReviewQueue({});

    expect(result.items).toHaveLength(1);
    expect(result.items[0].vendorId).toBe("stripe-vendor");
    expect((result.items[0] as any).verificationMethod).toBe("STRIPE_IDENTITY");
  });

  it("excludes a vendor who has never attempted verification through either path", async () => {
    m.vendor.findMany.mockResolvedValue([vendorRow({ id: "untouched" })] as never);
    m.verificationDocument.findMany.mockResolvedValue([] as never);

    const result = await verificationService.adminListReviewQueue({});

    expect(result.items).toHaveLength(0);
  });

  it("still includes a legacy vendor who only uploaded documents, no Stripe session", async () => {
    m.vendor.findMany.mockResolvedValue([vendorRow({ id: "doc-vendor" })] as never);
    m.verificationDocument.findMany.mockResolvedValue([
      { id: "d1", vendorId: "doc-vendor", type: "GOVERNMENT_ID", status: "PENDING", createdAt: new Date("2026-01-05"), deletedAt: null, frontUrl: "f", backUrl: null },
    ] as never);

    const result = await verificationService.adminListReviewQueue({});

    expect(result.items).toHaveLength(1);
    expect((result.items[0] as any).verificationMethod).toBe("MANUAL_DOCUMENTS");
  });

  it("marks a vendor who attempted both paths as BOTH", async () => {
    m.vendor.findMany.mockResolvedValue([vendorRow({ id: "both-vendor", stripeVerificationSessionId: "vs_999" })] as never);
    m.verificationDocument.findMany.mockResolvedValue([
      { id: "d1", vendorId: "both-vendor", type: "GOVERNMENT_ID", status: "PENDING", createdAt: new Date("2026-01-05"), deletedAt: null, frontUrl: "f", backUrl: null },
    ] as never);

    const result = await verificationService.adminListReviewQueue({});

    expect((result.items[0] as any).verificationMethod).toBe("BOTH");
  });
});

describe("adminGetReviewDetails — Stripe Identity rejection reason is visible", () => {
  it("falls back to the vendor's Stripe failure reason when no document carries one", async () => {
    m.vendor.findUnique.mockResolvedValue({
      id: "v1", storeName: "Queen Foods", storeSlug: "queen-foods", contactEmail: null, contactPhone: null,
      country: "GB", city: "London", verificationStatus: "REJECTED", createdAt: new Date("2026-01-01"),
      stripeVerificationSessionId: "vs_1", verifiedAt: null, verificationFailureReason: "Document image was blurry",
      user: { id: "u1", name: "Amara", email: "amara@example.com", phone: null },
    } as never);
    m.verificationDocument.findMany.mockResolvedValue([] as never);

    const details = await verificationService.adminGetReviewDetails("v1");

    expect(details.rejectionReason).toBe("Document image was blurry");
    expect((details as any).verificationMethod).toBe("STRIPE_IDENTITY");
  });
});

describe("adminApproveVendorVerification / adminRejectVendorVerification — write the same field Stripe Identity does", () => {
  // Legacy (pre-Stripe) vendor: no Stripe session/account, at least one document.
  const baseVendor = { id: "v1", userId: "u1", storeName: "Queen Foods", stripeVerificationSessionId: null, stripeAccountId: null, user: { email: "amara@example.com" } };
  beforeEach(() => { m.verificationDocument.count.mockResolvedValue(1 as never); });

  it("approve clears verificationFailureReason, same as a successful Stripe Identity webhook", async () => {
    m.vendor.findUnique.mockResolvedValueOnce(baseVendor as never).mockResolvedValueOnce({
      id: "v1", storeName: "Queen Foods", storeSlug: "s", contactEmail: null, contactPhone: null, country: null, city: null,
      verificationStatus: "VERIFIED", createdAt: new Date(), stripeVerificationSessionId: null, verifiedAt: null, verificationFailureReason: null,
      user: { id: "u1", name: "Amara", email: "amara@example.com", phone: null },
    } as never);
    m.verificationDocument.findMany.mockResolvedValue([] as never);

    await verificationService.adminApproveVendorVerification("admin-1", "v1");

    expect(m.vendor.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ verificationStatus: "VERIFIED", verificationFailureReason: null }) }),
    );
  });

  it("reject writes verificationFailureReason on the Vendor row, not only the per-document rejectionReason", async () => {
    m.vendor.findUnique.mockResolvedValueOnce(baseVendor as never).mockResolvedValueOnce({
      id: "v1", storeName: "Queen Foods", storeSlug: "s", contactEmail: null, contactPhone: null, country: null, city: null,
      verificationStatus: "REJECTED", createdAt: new Date(), stripeVerificationSessionId: null, verifiedAt: null, verificationFailureReason: "Blurry ID photo",
      user: { id: "u1", name: "Amara", email: "amara@example.com", phone: null },
    } as never);
    m.verificationDocument.findMany.mockResolvedValue([] as never);

    await verificationService.adminRejectVendorVerification("admin-1", "v1", "Blurry ID photo");

    expect(m.vendor.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ verificationStatus: "REJECTED", verificationFailureReason: "Blurry ID photo" }) }),
    );
  });
});

describe("manual approve/reject is refused for provider-controlled (Stripe) verification - Handbook 14.3", () => {
  it("409s approve for a vendor with a Stripe Identity session", async () => {
    m.vendor.findUnique.mockResolvedValueOnce({ id: "v1", userId: "u1", storeName: "Q", stripeVerificationSessionId: "vs_1", stripeAccountId: null, user: { email: "a@b.com" } } as never);
    m.verificationDocument.count.mockResolvedValue(0 as never);
    await expect(verificationService.adminApproveVendorVerification("admin-1", "v1")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("409s reject for a vendor with a Stripe Connect account", async () => {
    m.vendor.findUnique.mockResolvedValueOnce({ id: "v1", userId: "u1", storeName: "Q", stripeVerificationSessionId: null, stripeAccountId: "acct_1", user: { email: "a@b.com" } } as never);
    m.verificationDocument.count.mockResolvedValue(2 as never);
    await expect(verificationService.adminRejectVendorVerification("admin-1", "v1", "nope reason")).rejects.toMatchObject({ statusCode: 409 });
    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("409s approve for a vendor that never submitted anything (must use Stripe)", async () => {
    m.vendor.findUnique.mockResolvedValueOnce({ id: "v1", userId: "u1", storeName: "Q", stripeVerificationSessionId: null, stripeAccountId: null, user: { email: "a@b.com" } } as never);
    m.verificationDocument.count.mockResolvedValue(0 as never);
    await expect(verificationService.adminApproveVendorVerification("admin-1", "v1")).rejects.toMatchObject({ statusCode: 409 });
  });
});
