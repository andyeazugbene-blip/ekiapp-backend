/**
 * Phase F (reliability) / financial-ledger correctness — two small but
 * load-bearing Community Buy utilities had zero test coverage:
 *
 * - alertOps(): the shared ops-notification primitive used by every
 *   failure-path alert in Community Buy (failed payout, reconciliation
 *   mismatch, dispute reversal). Its never-throws, no-op-when-unconfigured
 *   contract is relied on everywhere it's called — worth proving directly.
 * - resolveCampaignConnectedAccountId()/resolveCampaignSupplierLedgerOwnerId():
 *   the dual-path (SupplierAccount vs legacy Vendor) resolver that decides
 *   which real Stripe account and ledger owner a settlement actually
 *   targets. A wrong branch here misroutes real money.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/email-queue", () => ({ enqueueEmail: vi.fn() }));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("../lib/prisma", () => ({
  prisma: {
    supplierAccount: { findUnique: vi.fn() },
    supplierProfile: { findUnique: vi.fn() },
  },
}));

import { enqueueEmail } from "../lib/email-queue";
import { prisma } from "../lib/prisma";
import { alertOps } from "../modules/community-buy/ops-alert.service";
import { resolveCampaignConnectedAccountId, resolveCampaignSupplierLedgerOwnerId } from "../modules/community-buy/campaign-supplier-resolution.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPS_ALERT_EMAIL;
});

describe("alertOps — never-throws, no-op-when-unconfigured contract", () => {
  it("is a silent no-op when OPS_ALERT_EMAIL is not configured — never invents a default recipient", async () => {
    await alertOps("Test subject", "<p>body</p>");
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("enqueues the real subject/html to the configured ops address", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@eki.example";
    await alertOps("Payout failed", "<p>details</p>");
    expect(enqueueEmail).toHaveBeenCalledWith({ to: "ops@eki.example", subject: "Payout failed", html: "<p>details</p>" });
  });

  it("swallows a failed enqueue rather than throwing — a broken ops alert must never break the caller's real transaction", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@eki.example";
    vi.mocked(enqueueEmail).mockRejectedValueOnce(new Error("queue down"));
    await expect(alertOps("subject", "html")).resolves.toBeUndefined();
  });
});

describe("resolveCampaignConnectedAccountId — dual-path Stripe account resolution", () => {
  it("returns null for a SELF-fulfilled campaign — never resolves a Stripe account for one", async () => {
    const result = await resolveCampaignConnectedAccountId({ fulfilmentOwner: "SELF", supplierAccountId: "acct-1", supplierId: null });
    expect(result).toBeNull();
    expect(m.supplierAccount.findUnique).not.toHaveBeenCalled();
  });

  it("resolves via the SupplierAccount path when supplierAccountId is set — never falls through to the legacy path", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: "acct_new123" });
    const result = await resolveCampaignConnectedAccountId({ fulfilmentOwner: "SUPPLIER", supplierAccountId: "acct-1", supplierId: "legacy-1" });
    expect(result).toBe("acct_new123");
    expect(m.supplierProfile.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the legacy Vendor path when only supplierId is set", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ vendor: { stripeAccountId: "acct_legacy456" } });
    const result = await resolveCampaignConnectedAccountId({ fulfilmentOwner: "SUPPLIER", supplierAccountId: null, supplierId: "legacy-1" });
    expect(result).toBe("acct_legacy456");
  });

  it("returns null (never throws) when neither supplier reference is set on a SUPPLIER-fulfilled campaign", async () => {
    const result = await resolveCampaignConnectedAccountId({ fulfilmentOwner: "SUPPLIER", supplierAccountId: null, supplierId: null });
    expect(result).toBeNull();
  });

  it("returns null when the referenced SupplierAccount row itself has no connected account yet", async () => {
    m.supplierAccount.findUnique.mockResolvedValue({ providerConnectedAccountId: null });
    const result = await resolveCampaignConnectedAccountId({ fulfilmentOwner: "SUPPLIER", supplierAccountId: "acct-1", supplierId: null });
    expect(result).toBeNull();
  });
});

describe("resolveCampaignSupplierLedgerOwnerId — dual-path ledger owner resolution", () => {
  it("uses the SupplierAccount id directly when set — no lookup needed", async () => {
    const result = await resolveCampaignSupplierLedgerOwnerId({ supplierAccountId: "acct-1", supplierId: "legacy-1" });
    expect(result).toBe("acct-1");
    expect(m.supplierProfile.findUnique).not.toHaveBeenCalled();
  });

  it("resolves the legacy path's ledger owner to the Vendor id (not the SupplierProfile id)", async () => {
    m.supplierProfile.findUnique.mockResolvedValue({ vendorId: "vendor-99" });
    const result = await resolveCampaignSupplierLedgerOwnerId({ supplierAccountId: null, supplierId: "legacy-1" });
    expect(result).toBe("vendor-99");
  });

  it("returns null when neither reference is set", async () => {
    const result = await resolveCampaignSupplierLedgerOwnerId({ supplierAccountId: null, supplierId: null });
    expect(result).toBeNull();
  });
});
