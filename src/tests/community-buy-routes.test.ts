/**
 * Controller/HTTP-level tests for the Community Buy routes — the same
 * regression class as regular-deliveries-routes.test.ts: real requests
 * through the real Express router, not just the service layer, so a
 * broken :id param, a missing auth gate, or a role check applied to the
 * wrong router actually fails a test.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const mockApplyAsOrganiser = vi.fn();
const mockApplyAsSupplier = vi.fn();
const mockGetOrganiserProfile = vi.fn();
const mockGetSupplierProfile = vi.fn();
const mockListVerifiedSuppliers = vi.fn();
const mockListPendingOrganisers = vi.fn();
const mockListPendingSuppliers = vi.fn();
const mockVerifyOrganiser = vi.fn();
const mockVerifySupplier = vi.fn();
const mockListVerifiedOrganisersForAdmin = vi.fn();
const mockListVerifiedSuppliersForAdmin = vi.fn();
const mockRestrictOrganiser = vi.fn();
const mockUnrestrictOrganiser = vi.fn();
const mockRestrictSupplier = vi.fn();
const mockUnrestrictSupplier = vi.fn();

vi.mock("../modules/community-buy/organiser-supplier.service", () => ({
  organiserSupplierService: {
    applyAsOrganiser: (...a: unknown[]) => mockApplyAsOrganiser(...a),
    applyAsSupplier: (...a: unknown[]) => mockApplyAsSupplier(...a),
    getOrganiserProfile: (...a: unknown[]) => mockGetOrganiserProfile(...a),
    getSupplierProfile: (...a: unknown[]) => mockGetSupplierProfile(...a),
    listVerifiedSuppliers: (...a: unknown[]) => mockListVerifiedSuppliers(...a),
    listPendingOrganisers: (...a: unknown[]) => mockListPendingOrganisers(...a),
    listPendingSuppliers: (...a: unknown[]) => mockListPendingSuppliers(...a),
    verifyOrganiser: (...a: unknown[]) => mockVerifyOrganiser(...a),
    verifySupplier: (...a: unknown[]) => mockVerifySupplier(...a),
    listVerifiedOrganisersForAdmin: (...a: unknown[]) => mockListVerifiedOrganisersForAdmin(...a),
    listVerifiedSuppliersForAdmin: (...a: unknown[]) => mockListVerifiedSuppliersForAdmin(...a),
    restrictOrganiser: (...a: unknown[]) => mockRestrictOrganiser(...a),
    unrestrictOrganiser: (...a: unknown[]) => mockUnrestrictOrganiser(...a),
    restrictSupplier: (...a: unknown[]) => mockRestrictSupplier(...a),
    unrestrictSupplier: (...a: unknown[]) => mockUnrestrictSupplier(...a),
  },
}));

const mockListLive = vi.fn();
const mockGetCampaign = vi.fn();
const mockCreateCampaign = vi.fn();
const mockUpdateCampaign = vi.fn();
const mockSubmitCampaign = vi.fn();
const mockPublishCampaign = vi.fn();
const mockListForOrganiser = vi.fn();
const mockListForSupplier = vi.fn();
const mockListForReview = vi.fn();
const mockListRecentlyClosed = vi.fn();
const mockApproveCampaign = vi.fn();
const mockRequestChanges = vi.fn();
const mockRejectCampaign = vi.fn();
const mockPauseCampaign = vi.fn();
const mockResumeCampaign = vi.fn();
const mockEndRescueAndRefund = vi.fn();
const mockRequestExtension = vi.fn();
const mockConfirmSupplierCommitment = vi.fn();
const mockApproveExtension = vi.fn();
const mockRejectExtension = vi.fn();
const mockListExtensionRequestsForAdmin = vi.fn();
const mockRequireOwnedByOrganiser = vi.fn();
const mockListMyCampaignUpdates = vi.fn();
const mockListParticipantsForOrganiser = vi.fn();
const mockGetRefundProgressForOrganiser = vi.fn();

vi.mock("../modules/community-buy/community-campaigns.service", () => ({
  communityCampaignsService: {
    listLive: (...a: unknown[]) => mockListLive(...a),
    listMyCampaignUpdates: (...a: unknown[]) => mockListMyCampaignUpdates(...a),
    listParticipantsForOrganiser: (...a: unknown[]) => mockListParticipantsForOrganiser(...a),
    getRefundProgressForOrganiser: (...a: unknown[]) => mockGetRefundProgressForOrganiser(...a),
    get: (...a: unknown[]) => mockGetCampaign(...a),
    create: (...a: unknown[]) => mockCreateCampaign(...a),
    update: (...a: unknown[]) => mockUpdateCampaign(...a),
    requireOwnedByOrganiser: (...a: unknown[]) => mockRequireOwnedByOrganiser(...a),
    endRescueAndRefund: (...a: unknown[]) => mockEndRescueAndRefund(...a),
    requestExtension: (...a: unknown[]) => mockRequestExtension(...a),
    confirmSupplierCommitment: (...a: unknown[]) => mockConfirmSupplierCommitment(...a),
    approveExtension: (...a: unknown[]) => mockApproveExtension(...a),
    rejectExtension: (...a: unknown[]) => mockRejectExtension(...a),
    listExtensionRequestsForAdmin: (...a: unknown[]) => mockListExtensionRequestsForAdmin(...a),
    submit: (...a: unknown[]) => mockSubmitCampaign(...a),
    publish: (...a: unknown[]) => mockPublishCampaign(...a),
    listForOrganiser: (...a: unknown[]) => mockListForOrganiser(...a),
    listForSupplier: (...a: unknown[]) => mockListForSupplier(...a),
    listForReview: (...a: unknown[]) => mockListForReview(...a),
    listRecentlyClosed: (...a: unknown[]) => mockListRecentlyClosed(...a),
    approve: (...a: unknown[]) => mockApproveCampaign(...a),
    requestChanges: (...a: unknown[]) => mockRequestChanges(...a),
    reject: (...a: unknown[]) => mockRejectCampaign(...a),
    pause: (...a: unknown[]) => mockPauseCampaign(...a),
    resume: (...a: unknown[]) => mockResumeCampaign(...a),
  },
}));

const mockJoin = vi.fn();
const mockPledge = vi.fn();
const mockCreateOrganiserTopUp = vi.fn();
const mockGetMyContribution = vi.fn();
const mockGetMyPaymentForCampaign = vi.fn();
const mockRetryCharge = vi.fn();
const mockReleaseSupplierPayment = vi.fn();
const mockHoldSupplierPayment = vi.fn();
const mockGetLedgerSummaryForAdmin = vi.fn();
const mockGetCampaignLedger = vi.fn();
const mockListMyContributions = vi.fn();
const mockCreateSupportCase = vi.fn();
const mockListMySupportCases = vi.fn();
const mockGetMySupportCase = vi.fn();
const mockListSupportCasesForAdmin = vi.fn();
const mockGetSupportCaseForAdmin = vi.fn();
const mockAdminUpdateSupportCase = vi.fn();

vi.mock("../modules/community-buy/campaign-contributions.service", () => ({
  campaignContributionsService: {
    join: (...a: unknown[]) => mockJoin(...a),
    listMyContributions: (...a: unknown[]) => mockListMyContributions(...a),
    pledge: (...a: unknown[]) => mockPledge(...a),
    pledgeOrganiserTopUp: (...a: unknown[]) => mockCreateOrganiserTopUp(...a),
    getMyContribution: (...a: unknown[]) => mockGetMyContribution(...a),
    getMyPaymentForCampaign: (...a: unknown[]) => mockGetMyPaymentForCampaign(...a),
    retryCharge: (...a: unknown[]) => mockRetryCharge(...a),
    releaseSupplierPayment: (...a: unknown[]) => mockReleaseSupplierPayment(...a),
    holdSupplierPayment: (...a: unknown[]) => mockHoldSupplierPayment(...a),
    listRefundsForAdmin: vi.fn().mockResolvedValue([]),
    getLedgerSummaryForAdmin: (...a: unknown[]) => mockGetLedgerSummaryForAdmin(...a),
    getCampaignLedger: (...a: unknown[]) => mockGetCampaignLedger(...a),
  },
}));

const mockGetSupplierFulfilment = vi.fn();
const mockConfirmFulfilmentInventory = vi.fn();
const mockSetFulfilmentPlan = vi.fn();
const mockStartFulfilmentPacking = vi.fn();
const mockMarkFulfilmentReady = vi.fn();
const mockMarkFulfilmentDispatched = vi.fn();
const mockMarkFulfilmentCollected = vi.fn();
const mockGetOrganiserFulfilment = vi.fn();
const mockOrganiserConfirmFulfilmentCompletion = vi.fn();

vi.mock("../modules/community-buy/campaign-fulfilment.service", () => ({
  campaignFulfilmentService: {
    getForSupplier: (...a: unknown[]) => mockGetSupplierFulfilment(...a),
    confirmInventory: (...a: unknown[]) => mockConfirmFulfilmentInventory(...a),
    setPlan: (...a: unknown[]) => mockSetFulfilmentPlan(...a),
    startPacking: (...a: unknown[]) => mockStartFulfilmentPacking(...a),
    markReady: (...a: unknown[]) => mockMarkFulfilmentReady(...a),
    markDispatched: (...a: unknown[]) => mockMarkFulfilmentDispatched(...a),
    markCollected: (...a: unknown[]) => mockMarkFulfilmentCollected(...a),
    getForOrganiser: (...a: unknown[]) => mockGetOrganiserFulfilment(...a),
    organiserConfirmCompletion: (...a: unknown[]) => mockOrganiserConfirmFulfilmentCompletion(...a),
  },
}));

vi.mock("../modules/community-buy/support-case.service", () => ({
  supportCaseService: {
    create: (...a: unknown[]) => mockCreateSupportCase(...a),
    listMine: (...a: unknown[]) => mockListMySupportCases(...a),
    getMine: (...a: unknown[]) => mockGetMySupportCase(...a),
    listForAdmin: (...a: unknown[]) => mockListSupportCasesForAdmin(...a),
    getForAdmin: (...a: unknown[]) => mockGetSupportCaseForAdmin(...a),
    adminUpdate: (...a: unknown[]) => mockAdminUpdateSupportCase(...a),
  },
}));

const mockMarketList = vi.fn();
const mockMarketGet = vi.fn();
const mockMarketUpdate = vi.fn();

vi.mock("../modules/community-buy/market-configuration.service", () => ({
  marketConfigurationService: {
    list: (...a: unknown[]) => mockMarketList(...a),
    get: (...a: unknown[]) => mockMarketGet(...a),
    update: (...a: unknown[]) => mockMarketUpdate(...a),
  },
}));

const mockVendorFindUnique = vi.fn();
// Four-eyes gate on supplier-payment release (see admin-approvals.service.ts)
// looks up the payment amount before deciding whether to release directly
// or create a pending approval.
const mockCampaignSupplierPaymentFindUnique = vi.fn().mockResolvedValue({ amount: 50000 });
// With requiresApproval defaulting to false, release proceeds exactly as
// this file's pre-existing tests expect.
const mockRequiresApproval = vi.fn().mockResolvedValue(false);
const mockRequestApproval = vi.fn();

vi.mock("../modules/admin/admin-approvals.service", () => ({
  adminApprovalsService: {
    requiresApproval: (...a: unknown[]) => mockRequiresApproval(...a),
    requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
  },
}));
vi.mock("../lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("../lib/prisma")>("../lib/prisma");
  return {
    prisma: new Proxy(actual.prisma, {
      get(target, prop) {
        if (prop === "vendor") return { findUnique: (...a: unknown[]) => mockVendorFindUnique(...a) };
        if (prop === "campaignSupplierPayment") return { findUnique: (...a: unknown[]) => mockCampaignSupplierPaymentFindUnique(...a) };
        // require2fa (gates the two supplier-payment routes below) looks
        // this up for every request — without a mock it falls through to
        // a real DB call, which this test environment can't make. No admin
        // in these tests has 2FA enrolled.
        if (prop === "adminTwoFactor") return { findUnique: vi.fn().mockResolvedValue(null) };
        return (target as any)[prop];
      },
    }),
  };
});

vi.mock("../modules/admin/admin-roles.service", () => ({
  adminRolesService: { assertPermission: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../middlewares/authenticate", async () => {
  const actual = await vi.importActual<typeof import("../middlewares/authenticate")>(
    "../middlewares/authenticate",
  );
  const { AppError } = await import("../shared/errors/app-error");
  return {
    ...actual,
    authenticate(request: any, _res: any, next: any) {
      const header = request.headers.authorization as string | undefined;
      if (!header || !header.startsWith("Bearer ")) {
        next(new AppError("Missing or invalid Authorization header", 401));
        return;
      }
      try {
        const token = header.slice(7);
        const payload = jwt.verify(token, "test-secret-key-for-testing-only") as {
          sub: string;
          role: "BUYER" | "VENDOR" | "ADMIN";
          email: string;
        };
        request.user = { id: payload.sub, role: payload.role, email: payload.email };
        next();
      } catch {
        next(new AppError("Invalid token", 401));
      }
    },
  };
});

import request from "supertest";
import type { Express } from "express";
import { generateTestToken } from "./helpers";

let app: Express;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.app;
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockVendorFindUnique.mockResolvedValue({ id: "vendor-db-1" });
  mockListLive.mockResolvedValue([]);
  mockGetCampaign.mockResolvedValue({ id: "camp-1", status: "LIVE", paidTotal: 0, progressPct: 0 });
  mockJoin.mockResolvedValue({ id: "participant-1" });
  mockPledge.mockResolvedValue({ contributionId: "contrib-1", status: "PLEDGED" });
  mockCreateCampaign.mockResolvedValue({ id: "camp-2", status: "DRAFT" });
  mockUpdateCampaign.mockResolvedValue({ id: "camp-2", status: "DRAFT" });
  mockSubmitCampaign.mockResolvedValue({ id: "camp-2", status: "UNDER_REVIEW" });
  mockPublishCampaign.mockResolvedValue({ id: "camp-2", status: "LIVE" });
  mockEndRescueAndRefund.mockResolvedValue({ id: "camp-2", status: "FAILED" });
  mockRequestExtension.mockResolvedValue({ id: "ext-1", status: "PENDING" });
  mockConfirmSupplierCommitment.mockResolvedValue({ id: "camp-2", supplierCommitted: true });
  mockCreateOrganiserTopUp.mockResolvedValue({ contributionId: "contrib-top-1", clientSecret: "pi_test_secret" });
  mockApplyAsOrganiser.mockResolvedValue({ id: "org-1", isVerified: false });
  mockApplyAsSupplier.mockResolvedValue({ id: "sup-1", isVerified: false });
  mockGetOrganiserProfile.mockResolvedValue(null);
  mockGetSupplierProfile.mockResolvedValue(null);
  mockListForOrganiser.mockResolvedValue([]);
  mockListForSupplier.mockResolvedValue([]);
  mockListForReview.mockResolvedValue([]);
  mockListRecentlyClosed.mockResolvedValue([]);
  mockApproveCampaign.mockResolvedValue({ id: "camp-2", status: "APPROVED" });
  mockVerifyOrganiser.mockResolvedValue({ id: "org-1", isVerified: true });
  mockVerifySupplier.mockResolvedValue({ id: "sup-1", isVerified: true });
  mockMarketList.mockResolvedValue([{ countryCode: "GB", communityBuyEnabled: true }]);
  mockMarketGet.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: true });
  mockMarketUpdate.mockResolvedValue({ countryCode: "GB", communityBuyEnabled: false });
});

const buyerToken = () => generateTestToken({ id: "buyer-1", role: "BUYER", email: "b@x.com" });
const vendorToken = () => generateTestToken({ id: "vendor-user-1", role: "VENDOR", email: "v@x.com" });
const adminToken = () => generateTestToken({ id: "admin-1", role: "ADMIN", email: "a@x.com" });

describe("Public discovery routes", () => {
  it("GET /api/community-buy/campaigns — public, no auth required", async () => {
    const res = await request(app).get("/api/community-buy/campaigns?country=GB");
    expect(res.status).toBe(200);
    expect(mockListLive).toHaveBeenCalledWith("GB");
  });

  it("GET /api/community-buy/campaigns/:id — id parsed correctly, public", async () => {
    const res = await request(app).get("/api/community-buy/campaigns/camp-99");
    expect(res.status).toBe(200);
    expect(mockGetCampaign).toHaveBeenCalledWith("camp-99");
  });

  it("GET /api/community-buy/markets — public market list", async () => {
    const res = await request(app).get("/api/community-buy/markets");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});

describe("Participant routes", () => {
  it("POST /api/community-buy/campaigns/:id/join — 401 without token", async () => {
    const res = await request(app).post("/api/community-buy/campaigns/camp-99/join");
    expect(res.status).toBe(401);
  });

  it("POST /api/community-buy/campaigns/:id/join — 201, id parsed correctly", async () => {
    const res = await request(app).post("/api/community-buy/campaigns/camp-99/join").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(201);
    expect(mockJoin).toHaveBeenCalledWith("buyer-1", "camp-99");
  });

  it("POST /api/community-buy/campaigns/:id/contributions — 400 for a non-positive quantity", async () => {
    const res = await request(app)
      .post("/api/community-buy/campaigns/camp-99/contributions")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ quantity: 0, paymentMethodId: "pm-1" });
    expect(res.status).toBe(400);
    expect(mockPledge).not.toHaveBeenCalled();
  });

  it("POST /api/community-buy/campaigns/:id/contributions — 400 for a non-integer quantity", async () => {
    const res = await request(app)
      .post("/api/community-buy/campaigns/camp-99/contributions")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ quantity: 2.5, paymentMethodId: "pm-1" });
    expect(res.status).toBe(400);
    expect(mockPledge).not.toHaveBeenCalled();
  });

  it("POST /api/community-buy/campaigns/:id/contributions — 400 when paymentMethodId is missing (no upfront capture — a saved card is required to pledge)", async () => {
    const res = await request(app)
      .post("/api/community-buy/campaigns/camp-99/contributions")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ quantity: 2 });
    expect(res.status).toBe(400);
    expect(mockPledge).not.toHaveBeenCalled();
  });

  it("POST /api/community-buy/campaigns/:id/contributions — 201 for a valid quantity + payment method", async () => {
    const res = await request(app)
      .post("/api/community-buy/campaigns/camp-99/contributions")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ quantity: 2, paymentMethodId: "pm-1" });
    expect(res.status).toBe(201);
    expect(mockPledge).toHaveBeenCalledWith("buyer-1", "camp-99", 2, "pm-1");
  });

  it("GET /api/community-buy/my-contributions — 401 without token, 200 for a buyer, and is NOT swallowed by /campaigns/:id", async () => {
    const unauth = await request(app).get("/api/community-buy/my-contributions");
    expect(unauth.status).toBe(401);

    mockListMyContributions.mockResolvedValue([{ campaign: { id: "camp-1" }, totalQuantity: 2 }]);
    const res = await request(app).get("/api/community-buy/my-contributions").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockListMyContributions).toHaveBeenCalledWith("buyer-1");
    expect(mockGetCampaign).not.toHaveBeenCalled();
    expect(res.body.items).toHaveLength(1);
  });

  it("GET /api/community-buy/campaigns/:id/updates — 401 without token, id parsed correctly for a buyer", async () => {
    const unauth = await request(app).get("/api/community-buy/campaigns/camp-99/updates");
    expect(unauth.status).toBe(401);

    mockListMyCampaignUpdates.mockResolvedValue([]);
    const res = await request(app).get("/api/community-buy/campaigns/camp-99/updates").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockListMyCampaignUpdates).toHaveBeenCalledWith("buyer-1", "camp-99");
  });

  it("POST /api/community-buy/campaigns/:id/support-cases — 401 without token, 400 for an unknown case type", async () => {
    const unauth = await request(app).post("/api/community-buy/campaigns/camp-99/support-cases").send({});
    expect(unauth.status).toBe(401);

    const bad = await request(app)
      .post("/api/community-buy/campaigns/camp-99/support-cases")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ caseType: "NOT_A_REAL_TYPE", description: "help" });
    expect(bad.status).toBe(400);
    expect(mockCreateSupportCase).not.toHaveBeenCalled();
  });

  it("POST /api/community-buy/campaigns/:id/support-cases — 201 for a valid case, id parsed correctly", async () => {
    mockCreateSupportCase.mockResolvedValue({ id: "case-1" });
    const res = await request(app)
      .post("/api/community-buy/campaigns/camp-99/support-cases")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ caseType: "REFUND_ISSUE", description: "My refund hasn't arrived." });
    expect(res.status).toBe(201);
    expect(mockCreateSupportCase).toHaveBeenCalledWith("buyer-1", "camp-99", expect.objectContaining({ caseType: "REFUND_ISSUE", description: "My refund hasn't arrived." }));
  });

  it("GET /api/community-buy/support-cases — 200 for a buyer, not swallowed by /campaigns/:id", async () => {
    mockListMySupportCases.mockResolvedValue([]);
    const res = await request(app).get("/api/community-buy/support-cases").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockListMySupportCases).toHaveBeenCalledWith("buyer-1");
    expect(mockGetCampaign).not.toHaveBeenCalled();
  });

  it("GET /api/community-buy/support-cases/:id — id parsed correctly", async () => {
    mockGetMySupportCase.mockResolvedValue({ id: "case-1" });
    const res = await request(app).get("/api/community-buy/support-cases/case-1").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetMySupportCase).toHaveBeenCalledWith("buyer-1", "case-1");
  });
});

describe("Admin support case routes", () => {
  it("GET /api/admin/community-buy/support-cases — 401 without token, 200 for admin", async () => {
    const unauth = await request(app).get("/api/admin/community-buy/support-cases");
    expect(unauth.status).toBe(401);

    mockListSupportCasesForAdmin.mockResolvedValue([]);
    const res = await request(app).get("/api/admin/community-buy/support-cases").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });

  it("GET /api/admin/community-buy/support-cases/:id — id parsed correctly", async () => {
    mockGetSupportCaseForAdmin.mockResolvedValue({ id: "case-1" });
    const res = await request(app).get("/api/admin/community-buy/support-cases/case-1").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetSupportCaseForAdmin).toHaveBeenCalledWith("case-1");
  });

  it("PATCH /api/admin/community-buy/support-cases/:id — 400 for an unknown status", async () => {
    const res = await request(app)
      .patch("/api/admin/community-buy/support-cases/case-1")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ status: "NOT_A_REAL_STATUS" });
    expect(res.status).toBe(400);
    expect(mockAdminUpdateSupportCase).not.toHaveBeenCalled();
  });

  it("PATCH /api/admin/community-buy/support-cases/:id — 400 when escalated is not a boolean", async () => {
    const res = await request(app)
      .patch("/api/admin/community-buy/support-cases/case-1")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ escalated: "yes" });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/admin/community-buy/support-cases/:id — 200 for a valid update, id parsed correctly", async () => {
    mockAdminUpdateSupportCase.mockResolvedValue({ id: "case-1", status: "RESOLVED" });
    const res = await request(app)
      .patch("/api/admin/community-buy/support-cases/case-1")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ status: "RESOLVED", customerVisibleResponse: "Refund has been reissued." });
    expect(res.status).toBe(200);
    expect(mockAdminUpdateSupportCase).toHaveBeenCalledWith("admin-1", "case-1", expect.objectContaining({ status: "RESOLVED", customerVisibleResponse: "Refund has been reissued." }));
  });
});

describe("Organiser routes — role/id handling", () => {
  it("GET /api/organiser/profile — 401 without token", async () => {
    const res = await request(app).get("/api/organiser/profile");
    expect(res.status).toBe(401);
  });

  it("POST /api/organiser/applications — 400 without a country", async () => {
    const res = await request(app).post("/api/organiser/applications").set("Authorization", `Bearer ${buyerToken()}`).send({});
    expect(res.status).toBe(400);
  });

  it("PATCH /api/organiser/campaigns/:id — id parsed correctly", async () => {
    const res = await request(app)
      .patch("/api/organiser/campaigns/camp-77")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ title: "New title" });
    expect(res.status).toBe(200);
    expect(mockUpdateCampaign).toHaveBeenCalledWith("buyer-1", "camp-77", expect.objectContaining({ title: "New title" }));
  });

  it("POST /api/organiser/campaigns/:id/submit and /publish — id parsed correctly for both", async () => {
    const submit = await request(app).post("/api/organiser/campaigns/camp-77/submit").set("Authorization", `Bearer ${buyerToken()}`);
    expect(submit.status).toBe(200);
    expect(mockSubmitCampaign).toHaveBeenCalledWith("buyer-1", "camp-77");

    const publish = await request(app).post("/api/organiser/campaigns/camp-77/publish").set("Authorization", `Bearer ${buyerToken()}`);
    expect(publish.status).toBe(200);
    expect(mockPublishCampaign).toHaveBeenCalledWith("buyer-1", "camp-77");
  });

  it("GET /api/organiser/campaigns/:id/participants — 401 without token, id parsed correctly", async () => {
    const unauth = await request(app).get("/api/organiser/campaigns/camp-77/participants");
    expect(unauth.status).toBe(401);

    mockListParticipantsForOrganiser.mockResolvedValue([]);
    const res = await request(app).get("/api/organiser/campaigns/camp-77/participants").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockListParticipantsForOrganiser).toHaveBeenCalledWith("buyer-1", "camp-77");
  });

  it("GET /api/organiser/campaigns/:id/refund-progress — id parsed correctly", async () => {
    mockGetRefundProgressForOrganiser.mockResolvedValue({ total: 0, completed: 0, pending: 0, failed: 0 });
    const res = await request(app).get("/api/organiser/campaigns/camp-77/refund-progress").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetRefundProgressForOrganiser).toHaveBeenCalledWith("buyer-1", "camp-77");
  });

  it("GET /api/organiser/suppliers — 400 without a country query param", async () => {
    const res = await request(app).get("/api/organiser/suppliers").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(400);
  });

  it("POST /api/organiser/campaigns/:id/rescue/end — 401 without token, id parsed correctly with one", async () => {
    const noAuth = await request(app).post("/api/organiser/campaigns/camp-77/rescue/end");
    expect(noAuth.status).toBe(401);

    const res = await request(app).post("/api/organiser/campaigns/camp-77/rescue/end").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe("FAILED");
    expect(mockEndRescueAndRefund).toHaveBeenCalledWith("buyer-1", "camp-77");
  });

  it("POST /api/organiser/campaigns/:id/rescue/top-up — quantity + payment method validated, id parsed correctly", async () => {
    const bad = await request(app)
      .post("/api/organiser/campaigns/camp-77/rescue/top-up")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ quantity: 0, paymentMethodId: "pm-1" });
    expect(bad.status).toBe(400);

    const noPaymentMethod = await request(app)
      .post("/api/organiser/campaigns/camp-77/rescue/top-up")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ quantity: 3 });
    expect(noPaymentMethod.status).toBe(400);

    const res = await request(app)
      .post("/api/organiser/campaigns/camp-77/rescue/top-up")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ quantity: 3, paymentMethodId: "pm-1" });
    expect(res.status).toBe(201);
    expect(mockCreateOrganiserTopUp).toHaveBeenCalledWith("buyer-1", "camp-77", 3, "pm-1");
  });

  it("POST /api/organiser/campaigns/:id/rescue/extension-request — requires requestedDeadline and reason", async () => {
    const bad = await request(app)
      .post("/api/organiser/campaigns/camp-77/rescue/extension-request")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({});
    expect(bad.status).toBe(400);
    expect(mockRequestExtension).not.toHaveBeenCalled();

    const res = await request(app)
      .post("/api/organiser/campaigns/camp-77/rescue/extension-request")
      .set("Authorization", `Bearer ${buyerToken()}`)
      .send({ requestedDeadline: "2026-12-01T00:00:00.000Z", reason: "need more time", supplierReconfirmed: true, priceUnchangedConfirmed: true, participantTermsUnchanged: true });
    expect(res.status).toBe(201);
    expect(mockRequestExtension).toHaveBeenCalledWith("buyer-1", "camp-77", {
      requestedDeadline: "2026-12-01T00:00:00.000Z",
      reason: "need more time",
      supplierReconfirmed: true,
      priceUnchangedConfirmed: true,
      participantTermsUnchanged: true,
    });
  });

  describe("legacy fulfil-anyway / cancel shim — temporary compatibility for the currently-deployed app", () => {
    it("fulfil-anyway always returns a controlled 409, never takes a financial action, regardless of campaign state", async () => {
      const res = await request(app).post("/api/organiser/campaigns/camp-77/fulfil-anyway").set("Authorization", `Bearer ${buyerToken()}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ENDPOINT_REPLACED");
      expect(mockEndRescueAndRefund).not.toHaveBeenCalled();
    });

    it("cancel on an already-FAILED campaign returns the current (already-refunding) state as a no-op — accurate, not a new action", async () => {
      mockRequireOwnedByOrganiser.mockResolvedValue({ id: "camp-77", status: "FAILED" });
      const res = await request(app).post("/api/organiser/campaigns/camp-77/cancel").set("Authorization", `Bearer ${buyerToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.campaign.status).toBe("FAILED");
      expect(mockEndRescueAndRefund).not.toHaveBeenCalled();
    });

    it("cancel on a LIVE campaign — ambiguous under the old model, returns a controlled 409 rather than guessing", async () => {
      mockRequireOwnedByOrganiser.mockResolvedValue({ id: "camp-77", status: "LIVE" });
      const res = await request(app).post("/api/organiser/campaigns/camp-77/cancel").set("Authorization", `Bearer ${buyerToken()}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ENDPOINT_REPLACED");
      expect(mockEndRescueAndRefund).not.toHaveBeenCalled();
    });
  });
});

describe("Supplier routes — vendor-only", () => {
  it("POST /api/supplier/applications — 403 for a buyer token (vendor-only route)", async () => {
    const res = await request(app).post("/api/supplier/applications").set("Authorization", `Bearer ${buyerToken()}`).send({ country: "GB" });
    expect(res.status).toBe(403);
    expect(mockApplyAsSupplier).not.toHaveBeenCalled();
  });

  it("POST /api/supplier/applications — 201 for a vendor token, resolves vendor id from the user", async () => {
    const res = await request(app).post("/api/supplier/applications").set("Authorization", `Bearer ${vendorToken()}`).send({ country: "GB" });
    expect(res.status).toBe(201);
    expect(mockApplyAsSupplier).toHaveBeenCalledWith("vendor-db-1", "GB");
  });

  it("GET /api/supplier/campaigns — 403 for a buyer token", async () => {
    const res = await request(app).get("/api/supplier/campaigns").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(403);
  });

  it("POST /api/supplier/campaigns/:id/supplier-commitment — 403 for a buyer, 200 for a vendor with id parsed correctly", async () => {
    const forbidden = await request(app).post("/api/supplier/campaigns/camp-77/supplier-commitment").set("Authorization", `Bearer ${buyerToken()}`);
    expect(forbidden.status).toBe(403);

    const res = await request(app).post("/api/supplier/campaigns/camp-77/supplier-commitment").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockConfirmSupplierCommitment).toHaveBeenCalledWith("vendor-db-1", "camp-77");
  });

  it("GET /api/supplier/campaigns/:id/fulfilment — 403 for a buyer, 200 for a vendor with id parsed correctly", async () => {
    const forbidden = await request(app).get("/api/supplier/campaigns/camp-77/fulfilment").set("Authorization", `Bearer ${buyerToken()}`);
    expect(forbidden.status).toBe(403);

    mockGetSupplierFulfilment.mockResolvedValue({ status: "AWAITING_INVENTORY_CONFIRMATION" });
    const res = await request(app).get("/api/supplier/campaigns/camp-77/fulfilment").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetSupplierFulfilment).toHaveBeenCalledWith("vendor-db-1", "camp-77");
  });

  it("POST /api/supplier/campaigns/:id/fulfilment/confirm-inventory — id parsed correctly", async () => {
    mockConfirmFulfilmentInventory.mockResolvedValue({ status: "INVENTORY_CONFIRMED" });
    const res = await request(app).post("/api/supplier/campaigns/camp-77/fulfilment/confirm-inventory").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockConfirmFulfilmentInventory).toHaveBeenCalledWith("vendor-db-1", "camp-77");
  });

  it("POST /api/supplier/campaigns/:id/fulfilment/plan — 400 for an invalid method, 200 for a valid one", async () => {
    const bad = await request(app)
      .post("/api/supplier/campaigns/camp-77/fulfilment/plan")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ method: "TELEPORT" });
    expect(bad.status).toBe(400);
    expect(mockSetFulfilmentPlan).not.toHaveBeenCalled();

    mockSetFulfilmentPlan.mockResolvedValue({ method: "DELIVERY" });
    const res = await request(app)
      .post("/api/supplier/campaigns/camp-77/fulfilment/plan")
      .set("Authorization", `Bearer ${vendorToken()}`)
      .send({ method: "DELIVERY", notes: "Fragile" });
    expect(res.status).toBe(200);
    expect(mockSetFulfilmentPlan).toHaveBeenCalledWith("vendor-db-1", "camp-77", expect.objectContaining({ method: "DELIVERY", notes: "Fragile" }));
  });

  it.each([
    ["start-packing", "/api/supplier/campaigns/camp-77/fulfilment/start-packing", mockStartFulfilmentPacking],
    ["ready", "/api/supplier/campaigns/camp-77/fulfilment/ready", mockMarkFulfilmentReady],
    ["dispatch", "/api/supplier/campaigns/camp-77/fulfilment/dispatch", mockMarkFulfilmentDispatched],
    ["collect", "/api/supplier/campaigns/camp-77/fulfilment/collect", mockMarkFulfilmentCollected],
  ])("POST %s — resolves vendor id + campaign id from the URL correctly", async (_label, path, mockFn) => {
    mockFn.mockResolvedValue({ status: "PACKING" });
    const res = await request(app).post(path).set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockFn).toHaveBeenCalledWith("vendor-db-1", "camp-77");
  });

  it("GET /api/supplier/campaigns/:id/payment — 403 for a buyer, 200 for a vendor with id parsed correctly", async () => {
    const forbidden = await request(app).get("/api/supplier/campaigns/camp-77/payment").set("Authorization", `Bearer ${buyerToken()}`);
    expect(forbidden.status).toBe(403);

    mockGetMyPaymentForCampaign.mockResolvedValue({ status: "NOT_RELEASED" });
    const res = await request(app).get("/api/supplier/campaigns/camp-77/payment").set("Authorization", `Bearer ${vendorToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetMyPaymentForCampaign).toHaveBeenCalledWith("vendor-db-1", "camp-77");
  });
});

describe("Organiser fulfilment routes", () => {
  it("GET /api/organiser/campaigns/:id/fulfilment — 401 without token, id parsed correctly", async () => {
    const unauth = await request(app).get("/api/organiser/campaigns/camp-77/fulfilment");
    expect(unauth.status).toBe(401);

    mockGetOrganiserFulfilment.mockResolvedValue({ status: "PACKING" });
    const res = await request(app).get("/api/organiser/campaigns/camp-77/fulfilment").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetOrganiserFulfilment).toHaveBeenCalledWith("buyer-1", "camp-77");
  });

  it("POST /api/organiser/campaigns/:id/fulfilment/confirm-completion — id parsed correctly", async () => {
    mockOrganiserConfirmFulfilmentCompletion.mockResolvedValue({ status: "COMPLETED" });
    const res = await request(app).post("/api/organiser/campaigns/camp-77/fulfilment/confirm-completion").set("Authorization", `Bearer ${buyerToken()}`);
    expect(res.status).toBe(200);
    expect(mockOrganiserConfirmFulfilmentCompletion).toHaveBeenCalledWith("buyer-1", "camp-77");
  });
});

describe("Admin routes — permission-gated, id handling", () => {
  it("GET /api/admin/community-campaigns/review — 401 without token", async () => {
    const res = await request(app).get("/api/admin/community-campaigns/review");
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/community-campaigns/closed — 401 without token, 200 for admin", async () => {
    const noAuth = await request(app).get("/api/admin/community-campaigns/closed");
    expect(noAuth.status).toBe(401);
    const res = await request(app).get("/api/admin/community-campaigns/closed").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockListRecentlyClosed).toHaveBeenCalledTimes(1);
  });

  it("POST /api/admin/community-campaigns/:id/approve — id parsed correctly for an admin", async () => {
    const res = await request(app).post("/api/admin/community-campaigns/camp-55/approve").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockApproveCampaign).toHaveBeenCalledWith("admin-1", "camp-55");
  });

  it("POST /api/admin/community-campaigns/:id/request-changes — 400 without notes", async () => {
    const res = await request(app).post("/api/admin/community-campaigns/camp-55/request-changes").set("Authorization", `Bearer ${adminToken()}`).send({});
    expect(res.status).toBe(400);
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it("POST /api/admin/community-buy/organisers/:id/verify — id parsed correctly", async () => {
    const res = await request(app).post("/api/admin/community-buy/organisers/org-9/verify").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockVerifyOrganiser).toHaveBeenCalledWith("org-9");
  });

  it("PATCH /api/admin/community-buy/markets/:id — id parsed correctly, forwards body", async () => {
    const res = await request(app)
      .patch("/api/admin/community-buy/markets/GB")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ communityBuyEnabled: false });
    expect(res.status).toBe(200);
    expect(mockMarketUpdate).toHaveBeenCalledWith("GB", { communityBuyEnabled: false });
  });

  it("GET /api/admin/community-buy/refunds — reachable for an admin", async () => {
    const res = await request(app).get("/api/admin/community-buy/refunds").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("GET /api/admin/community-buy/extension-requests — 401 without token, 200 for admin", async () => {
    mockListExtensionRequestsForAdmin.mockResolvedValue([]);
    const noAuth = await request(app).get("/api/admin/community-buy/extension-requests");
    expect(noAuth.status).toBe(401);
    const res = await request(app).get("/api/admin/community-buy/extension-requests").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });

  it("POST /api/admin/community-buy/extension-requests/:id/approve — id parsed correctly", async () => {
    mockApproveExtension.mockResolvedValue({ id: "ext-9", status: "APPROVED" });
    const res = await request(app).post("/api/admin/community-buy/extension-requests/ext-9/approve").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockApproveExtension).toHaveBeenCalledWith("admin-1", "ext-9");
  });

  it("POST /api/admin/community-buy/extension-requests/:id/reject — id parsed correctly", async () => {
    mockRejectExtension.mockResolvedValue({ id: "ext-9", status: "REJECTED" });
    const res = await request(app).post("/api/admin/community-buy/extension-requests/ext-9/reject").set("Authorization", `Bearer ${adminToken()}`).send({ notes: "not enough evidence" });
    expect(res.status).toBe(200);
    expect(mockRejectExtension).toHaveBeenCalledWith("admin-1", "ext-9", "not enough evidence");
  });

  it("POST /api/admin/community-campaigns/:id/supplier-payment/release — gated by a configured four-eyes rule creates a pending approval instead of releasing", async () => {
    mockRequiresApproval.mockResolvedValueOnce(true);
    mockRequestApproval.mockResolvedValueOnce({ id: "appr-1", status: "PENDING" });
    const res = await request(app).post("/api/admin/community-campaigns/camp-88/supplier-payment/release").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(202);
    expect(mockReleaseSupplierPayment).not.toHaveBeenCalled();
  });

  it("POST /api/admin/community-campaigns/:id/supplier-payment/release — id parsed correctly", async () => {
    mockReleaseSupplierPayment.mockResolvedValue({ campaignId: "camp-88", status: "PROCESSING" });
    const res = await request(app).post("/api/admin/community-campaigns/camp-88/supplier-payment/release").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockReleaseSupplierPayment).toHaveBeenCalledWith("admin-1", "camp-88");
  });

  it("POST /api/admin/community-campaigns/:id/supplier-payment/hold — requires a reason", async () => {
    const bad = await request(app).post("/api/admin/community-campaigns/camp-88/supplier-payment/hold").set("Authorization", `Bearer ${adminToken()}`).send({});
    expect(bad.status).toBe(400);
    expect(mockHoldSupplierPayment).not.toHaveBeenCalled();

    mockHoldSupplierPayment.mockResolvedValue({ campaignId: "camp-88", status: "ON_HOLD" });
    const res = await request(app).post("/api/admin/community-campaigns/camp-88/supplier-payment/hold").set("Authorization", `Bearer ${adminToken()}`).send({ reason: "payout account changed" });
    expect(res.status).toBe(200);
    expect(mockHoldSupplierPayment).toHaveBeenCalledWith("admin-1", "camp-88", "payout account changed");
  });

  it("GET /api/admin/community-buy/ledger — 401 without token, 200 for admin", async () => {
    mockGetLedgerSummaryForAdmin.mockResolvedValue([]);
    const noAuth = await request(app).get("/api/admin/community-buy/ledger");
    expect(noAuth.status).toBe(401);
    const res = await request(app).get("/api/admin/community-buy/ledger").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("GET /api/admin/community-campaigns/:id/ledger — id parsed correctly", async () => {
    mockGetCampaignLedger.mockResolvedValue({ campaign: { id: "camp-1" }, entries: [], totals: { totalContributed: 0, totalRefunded: 0, totalPaidToSupplier: 0, netPosition: 0 } });
    const res = await request(app).get("/api/admin/community-campaigns/camp-1/ledger").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockGetCampaignLedger).toHaveBeenCalledWith("camp-1");
  });

  it("GET /api/admin/community-buy/organisers — 401 without token, 200 for admin", async () => {
    mockListVerifiedOrganisersForAdmin.mockResolvedValue([]);
    const noAuth = await request(app).get("/api/admin/community-buy/organisers");
    expect(noAuth.status).toBe(401);
    const res = await request(app).get("/api/admin/community-buy/organisers").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });

  it("POST /api/admin/community-buy/organisers/:id/restrict — requires a reason, then forwards id + reason", async () => {
    const bad = await request(app).post("/api/admin/community-buy/organisers/org-9/restrict").set("Authorization", `Bearer ${adminToken()}`).send({});
    expect(bad.status).toBe(400);
    expect(mockRestrictOrganiser).not.toHaveBeenCalled();

    mockRestrictOrganiser.mockResolvedValue({ id: "org-9", isRestricted: true });
    const res = await request(app).post("/api/admin/community-buy/organisers/org-9/restrict").set("Authorization", `Bearer ${adminToken()}`).send({ reason: "repeated no-shows" });
    expect(res.status).toBe(200);
    expect(mockRestrictOrganiser).toHaveBeenCalledWith("org-9", "repeated no-shows");
  });

  it("POST /api/admin/community-buy/organisers/:id/unrestrict — id parsed correctly", async () => {
    mockUnrestrictOrganiser.mockResolvedValue({ id: "org-9", isRestricted: false });
    const res = await request(app).post("/api/admin/community-buy/organisers/org-9/unrestrict").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockUnrestrictOrganiser).toHaveBeenCalledWith("org-9");
  });

  it("GET /api/admin/community-buy/suppliers — 200 for admin", async () => {
    mockListVerifiedSuppliersForAdmin.mockResolvedValue([]);
    const res = await request(app).get("/api/admin/community-buy/suppliers").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });

  it("POST /api/admin/community-buy/suppliers/:id/restrict — requires a reason, then forwards id + reason", async () => {
    const bad = await request(app).post("/api/admin/community-buy/suppliers/sup-4/restrict").set("Authorization", `Bearer ${adminToken()}`).send({});
    expect(bad.status).toBe(400);
    expect(mockRestrictSupplier).not.toHaveBeenCalled();

    mockRestrictSupplier.mockResolvedValue({ id: "sup-4", isRestricted: true });
    const res = await request(app).post("/api/admin/community-buy/suppliers/sup-4/restrict").set("Authorization", `Bearer ${adminToken()}`).send({ reason: "quality complaints" });
    expect(res.status).toBe(200);
    expect(mockRestrictSupplier).toHaveBeenCalledWith("sup-4", "quality complaints");
  });

  it("POST /api/admin/community-buy/suppliers/:id/unrestrict — id parsed correctly", async () => {
    mockUnrestrictSupplier.mockResolvedValue({ id: "sup-4", isRestricted: false });
    const res = await request(app).post("/api/admin/community-buy/suppliers/sup-4/unrestrict").set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(mockUnrestrictSupplier).toHaveBeenCalledWith("sup-4");
  });
});
