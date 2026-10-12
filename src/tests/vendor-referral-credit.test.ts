/**
 * Handoff M-08 "referral.credit.earned". Credit amount comes from the
 * admin-configurable VENDOR_REFERRAL_CREDIT_MONTHS setting, never a
 * hardcoded number; application is ledger-only (no Stripe mutation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  vendorFindUnique: vi.fn(),
  referralFindUnique: vi.fn(),
  referralUpdateMany: vi.fn(),
  productCount: vi.fn(),
  deliveryZoneCount: vi.fn(),
  userFindUnique: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    vendor: { findUnique: m.vendorFindUnique },
    referral: { findUnique: m.referralFindUnique, updateMany: m.referralUpdateMany },
    product: { count: m.productCount },
    deliveryZone: { count: m.deliveryZoneCount },
    user: { findUnique: m.userFindUnique },
  },
}));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../shared/utils/audit", () => ({ recordAudit: m.recordAudit }));

const mockGetValue = vi.fn();
vi.mock("../modules/admin/admin-platform-settings.service", () => ({
  adminPlatformSettingsService: { getValue: (...a: unknown[]) => mockGetValue(...a) },
}));

const mockSend = vi.fn().mockResolvedValue({ outcome: "SENT" });
vi.mock("../modules/communications/communication.service", () => ({
  communicationService: { send: (...a: unknown[]) => mockSend(...a) },
}));

import { referralsService } from "../modules/referrals/referrals.service";

const VENDOR = {
  id: "vendor-1",
  userId: "user-vendor-1",
  storeName: "Mama Eki",
  verificationStatus: "VERIFIED",
};
const REFERRAL = {
  id: "ref-1",
  referrerId: "user-referrer-1",
  referredId: "user-vendor-1",
  bonusAmount: 500,
  currency: "EUR",
  creditedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.vendorFindUnique.mockResolvedValue(VENDOR);
  m.referralFindUnique.mockResolvedValue(REFERRAL);
  m.referralUpdateMany.mockResolvedValue({ count: 1 });
  m.productCount.mockResolvedValue(1);
  m.deliveryZoneCount.mockResolvedValue(1);
  m.userFindUnique.mockResolvedValue({ email: "referrer@test.local" });
  mockGetValue.mockResolvedValue(1);
  mockSend.mockResolvedValue({ outcome: "SENT" });
});

describe("referralsService.creditVendorReferralOnMembershipQualified", () => {
  it("credits the referrer once the referred vendor is verified with a product and a delivery zone", async () => {
    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: true });
    expect(m.referralUpdateMany).toHaveBeenCalledWith({
      where: { id: "ref-1", creditedAt: null },
      data: { creditedAt: expect.any(Date) },
    });
    expect(m.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "VENDOR_REFERRAL_CREDITED",
      entityId: "ref-1",
      metadata: expect.objectContaining({ referrerId: "user-referrer-1", creditMonths: 1 }),
    }));
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_referral_credit_earned",
      recipientId: "user-referrer-1",
      dedupeKey: "VENDOR_REFERRAL_CREDIT:ref-1",
    }));
  });

  it("never guesses a credit amount — does nothing when VENDOR_REFERRAL_CREDIT_MONTHS isn't configured", async () => {
    mockGetValue.mockResolvedValue(null);

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: false });
    expect(m.referralUpdateMany).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not credit when the referred vendor isn't verified yet", async () => {
    m.vendorFindUnique.mockResolvedValue({ ...VENDOR, verificationStatus: "PENDING" });

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: false });
    expect(m.referralUpdateMany).not.toHaveBeenCalled();
  });

  it("does not credit when the referred vendor's store setup is incomplete (no active product)", async () => {
    m.productCount.mockResolvedValue(0);

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: false });
    expect(m.referralUpdateMany).not.toHaveBeenCalled();
  });

  it("does not credit when the referred vendor's store setup is incomplete (no active delivery zone)", async () => {
    m.deliveryZoneCount.mockResolvedValue(0);

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: false });
    expect(m.referralUpdateMany).not.toHaveBeenCalled();
  });

  it("is idempotent — does nothing when there's no referral for this vendor's user", async () => {
    m.referralFindUnique.mockResolvedValue(null);

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: false });
  });

  it("is idempotent — does nothing when the referral was already credited", async () => {
    m.referralFindUnique.mockResolvedValue({ ...REFERRAL, creditedAt: new Date() });

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: false });
    expect(m.referralUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a self-referral", async () => {
    m.referralFindUnique.mockResolvedValue({ ...REFERRAL, referrerId: "user-vendor-1" });

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: false });
    expect(m.referralUpdateMany).not.toHaveBeenCalled();
  });

  it("loses the atomic claim race to a concurrent credit and does not double-send", async () => {
    m.referralUpdateMany.mockResolvedValue({ count: 0 });

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-1");

    expect(result).toEqual({ credited: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does nothing when the vendor can't be found", async () => {
    m.vendorFindUnique.mockResolvedValue(null);

    const result = await referralsService.creditVendorReferralOnMembershipQualified("vendor-ghost");

    expect(result).toEqual({ credited: false });
    expect(m.referralFindUnique).not.toHaveBeenCalled();
  });
});
