import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  applyAsOrganiser,
  applyAsSupplier,
  confirmContributionPayment,
  confirmFulfilmentInventory,
  confirmSupplierCommitment,
  createContribution,
  createOrganiserCampaign,
  createOrganiserTopUp,
  endCampaignRescue,
  getCampaign,
  getCampaignRefundProgress,
  getCampaignUpdates,
  getContribution,
  getMyOrganiserProfile,
  getMySupplierPayment,
  getMySupplierProfile,
  getOrganiserFulfilment,
  getPublicMarketConfig,
  getSupplierFulfilment,
  joinCampaign,
  legacyCancelFailedCampaignShim,
  legacyFulfilCampaignAnywayShim,
  listCampaignParticipants,
  listCampaigns,
  listMyContributions,
  listMyOrganiserCampaigns,
  listMySupplierCampaigns,
  listPublicMarketConfigs,
  listVerifiedSuppliers,
  markFulfilmentCollected,
  markFulfilmentDispatched,
  markFulfilmentReady,
  organiserConfirmFulfilmentCompletion,
  publishOrganiserCampaign,
  requestCampaignExtension,
  setFulfilmentPlan,
  startFulfilmentPacking,
  submitOrganiserCampaign,
  updateOrganiserCampaign,
} from "./community-buy.controller";

// Public discovery + participant actions — mounted at /community-buy.
export const communityBuyRouter = Router();
communityBuyRouter.get("/markets", asyncHandler(listPublicMarketConfigs));
communityBuyRouter.get("/markets/:country", asyncHandler(getPublicMarketConfig));
communityBuyRouter.get("/campaigns", asyncHandler(listCampaigns));
communityBuyRouter.get("/my-contributions", authenticate, asyncHandler(listMyContributions));
communityBuyRouter.get("/campaigns/:id", asyncHandler(getCampaign));
communityBuyRouter.get("/campaigns/:id/updates", authenticate, asyncHandler(getCampaignUpdates));
communityBuyRouter.post("/campaigns/:id/contributions", authenticate, asyncHandler(createContribution));
communityBuyRouter.get("/contributions/:id", authenticate, asyncHandler(getContribution));
communityBuyRouter.post("/contributions/:id/payment", authenticate, asyncHandler(confirmContributionPayment));

// Buyers/organisers join a live campaign — kept on the same router since
// it's participant-facing, not an organiser-only action.
communityBuyRouter.post("/campaigns/:id/join", authenticate, asyncHandler(joinCampaign));

// Organiser — mounted at /organiser.
export const organiserRouter = Router();
organiserRouter.use(authenticate);
organiserRouter.get("/profile", asyncHandler(getMyOrganiserProfile));
organiserRouter.post("/applications", asyncHandler(applyAsOrganiser));
organiserRouter.get("/suppliers", asyncHandler(listVerifiedSuppliers));
organiserRouter.get("/campaigns", asyncHandler(listMyOrganiserCampaigns));
organiserRouter.post("/campaigns", asyncHandler(createOrganiserCampaign));
organiserRouter.patch("/campaigns/:id", asyncHandler(updateOrganiserCampaign));
organiserRouter.post("/campaigns/:id/submit", asyncHandler(submitOrganiserCampaign));
organiserRouter.post("/campaigns/:id/publish", asyncHandler(publishOrganiserCampaign));
// Rescue-window actions — doc §8. "Fulfil anyway below minimum" does not
// exist; the only paths out of RESCUE_WINDOW are a real top-up purchase,
// inviting more participants (no endpoint — just sharing), a single
// admin-approved extension, or ending the campaign into refunds.
organiserRouter.post("/campaigns/:id/rescue/top-up", asyncHandler(createOrganiserTopUp));
organiserRouter.post("/campaigns/:id/rescue/extension-request", asyncHandler(requestCampaignExtension));
organiserRouter.post("/campaigns/:id/rescue/end", asyncHandler(endCampaignRescue));
organiserRouter.get("/campaigns/:id/participants", asyncHandler(listCampaignParticipants));
organiserRouter.get("/campaigns/:id/refund-progress", asyncHandler(getCampaignRefundProgress));
organiserRouter.get("/campaigns/:id/fulfilment", asyncHandler(getOrganiserFulfilment));
organiserRouter.post("/campaigns/:id/fulfilment/confirm-completion", asyncHandler(organiserConfirmFulfilmentCompletion));

// TEMPORARY compatibility shim for the currently-deployed mobile app — see
// the long comment in community-buy.controller.ts. Remove once the new
// mobile UI is live and legacy usage has dropped to zero in production.
organiserRouter.post("/campaigns/:id/fulfil-anyway", asyncHandler(legacyFulfilCampaignAnywayShim));
organiserRouter.post("/campaigns/:id/cancel", asyncHandler(legacyCancelFailedCampaignShim));

// Supplier — mounted at /supplier. Only a verified vendor may apply.
export const supplierRouter = Router();
supplierRouter.use(authenticate, requireRole("VENDOR"));
supplierRouter.get("/profile", asyncHandler(getMySupplierProfile));
supplierRouter.post("/applications", asyncHandler(applyAsSupplier));
supplierRouter.get("/campaigns", asyncHandler(listMySupplierCampaigns));
supplierRouter.post("/campaigns/:id/supplier-commitment", asyncHandler(confirmSupplierCommitment));
supplierRouter.get("/campaigns/:id/fulfilment", asyncHandler(getSupplierFulfilment));
supplierRouter.post("/campaigns/:id/fulfilment/confirm-inventory", asyncHandler(confirmFulfilmentInventory));
supplierRouter.post("/campaigns/:id/fulfilment/plan", asyncHandler(setFulfilmentPlan));
supplierRouter.post("/campaigns/:id/fulfilment/start-packing", asyncHandler(startFulfilmentPacking));
supplierRouter.post("/campaigns/:id/fulfilment/ready", asyncHandler(markFulfilmentReady));
supplierRouter.post("/campaigns/:id/fulfilment/dispatch", asyncHandler(markFulfilmentDispatched));
supplierRouter.post("/campaigns/:id/fulfilment/collect", asyncHandler(markFulfilmentCollected));
supplierRouter.get("/campaigns/:id/payment", asyncHandler(getMySupplierPayment));
