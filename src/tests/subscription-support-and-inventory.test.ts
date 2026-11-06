import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), update: vi.fn() },
  supportCase: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  subscription: { findUnique: vi.fn() },
  renewal: { findFirst: vi.fn() },
  notify: vi.fn(),
  enqueue: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: m.campaign,
    subscriptionSupportCase: m.supportCase,
    buyerSubscription: m.subscription,
    renewal: m.renewal,
  },
}));
vi.mock("../shared/utils/audit", () => ({ recordAudit: m.audit, requireAuditReason: (r: string) => r }));
vi.mock("../modules/community-buy/community-buy-notices", () => ({ notifyUserInAppAndEmail: m.notify }));
vi.mock("../modules/community-buy/market-configuration.service", () => ({ marketConfigurationService: { get: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: m.enqueue } }));

import { supplierCampaignActionsService } from "../modules/community-buy/supplier-campaign-actions.service";
import { subscriptionSupportCasesService } from "../modules/regular-deliveries/subscription-support-cases.service";

const CAMPAIGN = { id: "c1", title: "Yam", organiser: { userId: "org" }, supplierAccount: { userId: "sup" }, supplier: null };

beforeEach(() => {
  vi.clearAllMocks();
  m.campaign.findUnique.mockResolvedValue(CAMPAIGN);
  m.campaign.update.mockResolvedValue({ id: "c1" });
});

describe("CB69 inventory status", () => {
  it("only the campaign's supplier can report it", async () => {
    await expect(supplierCampaignActionsService.setInventoryStatus("stranger", "c1", "LIMITED")).rejects.toMatchObject({ statusCode: 404 });
    expect(m.campaign.update).not.toHaveBeenCalled();
  });

  it("works for a vendor supplying the campaign too", async () => {
    m.campaign.findUnique.mockResolvedValue({ ...CAMPAIGN, supplierAccount: null, supplier: { vendor: { userId: "vendor-user" } } });
    await expect(supplierCampaignActionsService.setInventoryStatus("vendor-user", "c1", "CONFIRMED")).resolves.toBeTruthy();
  });

  it.each([["MAYBE"], [""], [null], [1]])("refuses %s", async (status) => {
    await expect(supplierCampaignActionsService.setInventoryStatus("sup", "c1", status)).rejects.toMatchObject({ code: "INVALID_INVENTORY_STATUS" });
  });

  it("stays quiet on confirmed, and tells the organiser otherwise", async () => {
    await supplierCampaignActionsService.setInventoryStatus("sup", "c1", "CONFIRMED");
    expect(m.notify).not.toHaveBeenCalled();
    await supplierCampaignActionsService.setInventoryStatus("sup", "c1", "LIMITED");
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "org", title: "Stock is limited" }));
  });
});

describe("S63 support cases", () => {
  it("refuses an evidence link that isn't https", async () => {
    m.subscription.findUnique.mockResolvedValue({ id: "s1" });
    await expect(subscriptionSupportCasesService.create("admin", "s1", { caseType: "STOCK", description: "x", evidenceUrls: ["javascript:alert(1)"] })).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  });

  it("refuses a renewal from another subscription", async () => {
    m.subscription.findUnique.mockResolvedValue({ id: "s1" });
    m.renewal.findFirst.mockResolvedValue(null);
    await expect(subscriptionSupportCasesService.create("admin", "s1", { caseType: "STOCK", description: "x", renewalId: "other" })).rejects.toMatchObject({ code: "RENEWAL_MISMATCH" });
  });

  it("tells the buyer only about a new response, never internal notes", async () => {
    m.supportCase.findUnique.mockResolvedValue({ id: "k1", subscriptionId: "s1", status: "OPEN", escalated: false, customerVisibleResponse: "Old", subscription: { buyerId: "buyer" } });
    m.supportCase.update.mockResolvedValue({ id: "k1", status: "OPEN", escalated: false });

    await subscriptionSupportCasesService.update("admin", "k1", { internalNotes: "Secret" });
    expect(m.enqueue).not.toHaveBeenCalled();
    await subscriptionSupportCasesService.update("admin", "k1", { customerVisibleResponse: "Old" });
    expect(m.enqueue).not.toHaveBeenCalled();
    await subscriptionSupportCasesService.update("admin", "k1", { customerVisibleResponse: "New" });
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "buyer", body: "New" }));
  });

  it("records who resolved it", async () => {
    m.supportCase.findUnique.mockResolvedValue({ id: "k1", subscriptionId: "s1", status: "OPEN", escalated: false, customerVisibleResponse: null, subscription: { buyerId: "buyer" } });
    m.supportCase.update.mockResolvedValue({ id: "k1", status: "RESOLVED", escalated: false });
    await subscriptionSupportCasesService.update("admin", "k1", { status: "RESOLVED" });
    expect(m.supportCase.update.mock.calls[0][0].data).toMatchObject({ status: "RESOLVED", resolvedById: "admin" });
  });
});
