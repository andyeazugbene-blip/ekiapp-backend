import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  applyAsOrganiser,
  applyAsSupplier,
  confirmContributionPayment,
  cancelFailedCampaign,
  createContribution,
  createOrganiserCampaign,
  fulfilCampaignAnyway,
  getCampaign,
  getContribution,
  getMyOrganiserProfile,
  getMySupplierProfile,
  getPublicMarketConfig,
  joinCampaign,
  listCampaigns,
  listMyOrganiserCampaigns,
  listMySupplierCampaigns,
  listPublicMarketConfigs,
  listVerifiedSuppliers,
  publishOrganiserCampaign,
  submitOrganiserCampaign,
  updateOrganiserCampaign,
} from "./community-buy.controller";

// Public discovery + participant actions — mounted at /community-buy.
export const communityBuyRouter = Router();
communityBuyRouter.get("/markets", asyncHandler(listPublicMarketConfigs));
communityBuyRouter.get("/markets/:country", asyncHandler(getPublicMarketConfig));
communityBuyRouter.get("/campaigns", asyncHandler(listCampaigns));
communityBuyRouter.get("/campaigns/:id", asyncHandler(getCampaign));
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
// Post-failure decision — see community-campaigns.service.ts for why no
// financial action is taken by fulfil-anyway (client hasn't confirmed the
// charging behavior); cancel reuses the existing, already-built refund path.
organiserRouter.post("/campaigns/:id/fulfil-anyway", asyncHandler(fulfilCampaignAnyway));
organiserRouter.post("/campaigns/:id/cancel", asyncHandler(cancelFailedCampaign));

// Supplier — mounted at /supplier. Only a verified vendor may apply.
export const supplierRouter = Router();
supplierRouter.use(authenticate, requireRole("VENDOR"));
supplierRouter.get("/profile", asyncHandler(getMySupplierProfile));
supplierRouter.post("/applications", asyncHandler(applyAsSupplier));
supplierRouter.get("/campaigns", asyncHandler(listMySupplierCampaigns));
