import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { requireApprovedSupplier } from "../../middlewares/require-capability";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  acceptSupplierInvitation,
  applyAsOrganiser,
  applyAsSupplier,
  commitToCampaign,
  confirmContributionSetup,
  confirmFulfilmentInventory,
  confirmSupplierCommitment,
  decideCampaign,
  declineSupplierCommitment,
  getCampaignAuthorisationSummary,
  getMyCampaignPayout,
  pledgeContribution,
  reconfirmCampaign,
  retryContributionHold,
  withdrawContribution,
  createSupportCase,
  createOrganiserCampaign,
  createOrganiserTopUp,
  createSupplierInvitation,
  declineSupplierInvitation,
  endCampaignRescue,
  getCampaign,
  getCampaignRefundProgress,
  getCampaignUpdates,
  getContribution,
  getMyOrganiserProfile,
  getMySupplierPayment,
  getMySupplierProfile,
  getMySupportCase,
  getOrganiserFulfilment,
  getParticipantFulfilment,
  getPublicMarketConfig,
  getSupplierEmergencyContact,
  getSupplierFulfilment,
  getSupplierInvitation,
  getSupplierManifest,
  getSupplierStripeConnectStatus,
  joinCampaign,
  legacyCancelFailedCampaignShim,
  legacyFulfilCampaignAnywayShim,
  listCampaignParticipants,
  listCampaigns,
  listMyContributions,
  listMySupportCases,
  listMyOrganiserCampaigns,
  listMySupplierCampaigns,
  listPublicMarketConfigs,
  listSupplierInvitations,
  listVerifiedSuppliers,
  markFulfilmentCollected,
  markFulfilmentDispatched,
  markFulfilmentReady,
  onboardSupplierStripeConnect,
  organiserConfirmFulfilmentCompletion,
  postCampaignUpdate,
  publishOrganiserCampaign,
  reassignCampaignSupplier,
  refreshSupplierStripeConnect,
  requestCampaignExtension,
  retryContributionCharge,
  revokeSupplierInvitation,
  sendSupplierContactMessage,
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
communityBuyRouter.get("/support-cases", authenticate, asyncHandler(listMySupportCases));
communityBuyRouter.get("/support-cases/:id", authenticate, asyncHandler(getMySupportCase));
communityBuyRouter.get("/campaigns/:id", asyncHandler(getCampaign));
communityBuyRouter.get("/campaigns/:id/fulfilment", asyncHandler(getParticipantFulfilment));
communityBuyRouter.get("/campaigns/:id/updates", authenticate, asyncHandler(getCampaignUpdates));
// Organiser or supplier posts a real broadcast update — authorization
// (must be this campaign's organiser or supplier) is enforced in the
// service, not here, since either role is valid.
communityBuyRouter.post("/campaigns/:id/updates", authenticate, asyncHandler(postCampaignUpdate));
// Pledge — saves quantity + a reference to an already-collected payment
// method (see /buyer/payment-methods for the SetupIntent flow itself).
// No money moves until the campaign succeeds; see community-buy.
// controller.ts's pledgeContribution and its file-header comment.
communityBuyRouter.post("/campaigns/:id/contributions", authenticate, asyncHandler(pledgeContribution));
communityBuyRouter.get("/contributions/:id", authenticate, asyncHandler(getContribution));
communityBuyRouter.post("/contributions/:id/retry-charge", authenticate, asyncHandler(retryContributionCharge));

// M2 — AUTHORISE_THEN_CAPTURE participant flow (spec §16). Deliberately
// separate from the pledge/retry-charge routes above — see
// campaign-authorisation.service.ts's commit() doc comment.
communityBuyRouter.post("/campaigns/:id/commit", authenticate, asyncHandler(commitToCampaign));
communityBuyRouter.get("/campaigns/:id/authorisation-summary", authenticate, asyncHandler(getCampaignAuthorisationSummary));
communityBuyRouter.post("/contributions/:id/confirm-setup", authenticate, asyncHandler(confirmContributionSetup));
communityBuyRouter.post("/contributions/:id/withdraw", authenticate, asyncHandler(withdrawContribution));
communityBuyRouter.post("/contributions/:id/retry-hold", authenticate, asyncHandler(retryContributionHold));

// Buyers/organisers join a live campaign — kept on the same router since
// it's participant-facing, not an organiser-only action.
communityBuyRouter.post("/campaigns/:id/join", authenticate, asyncHandler(joinCampaign));
communityBuyRouter.post("/campaigns/:id/support-cases", authenticate, asyncHandler(createSupportCase));

// Supplier invitations — public-by-token (mandate item 7: the invitee may
// have no Eki account yet, so there is nothing to authenticate against
// until accept() itself creates one).
communityBuyRouter.get("/supplier-invitations/:token", asyncHandler(getSupplierInvitation));
communityBuyRouter.post("/supplier-invitations/:token/accept", asyncHandler(acceptSupplierInvitation));
communityBuyRouter.post("/supplier-invitations/:token/decline", asyncHandler(declineSupplierInvitation));

// Organiser — mounted at /organiser.
export const organiserRouter = Router();
organiserRouter.use(authenticate);
organiserRouter.get("/profile", asyncHandler(getMyOrganiserProfile));
organiserRouter.post("/applications", asyncHandler(applyAsOrganiser));
organiserRouter.get("/suppliers", asyncHandler(listVerifiedSuppliers));
organiserRouter.get("/campaigns", asyncHandler(listMyOrganiserCampaigns));
organiserRouter.post("/campaigns", asyncHandler(createOrganiserCampaign));
organiserRouter.patch("/campaigns/:id", asyncHandler(updateOrganiserCampaign));
// Necessary companion to supplier decline — moves a still-draft campaign
// to a different supplier so a decline is never a dead end.
organiserRouter.post("/campaigns/:id/supplier", asyncHandler(reassignCampaignSupplier));
// Supplier invitations (item 7) — create/list/revoke are organiser-only.
organiserRouter.post("/campaigns/:id/supplier-invitations", asyncHandler(createSupplierInvitation));
organiserRouter.get("/campaigns/:id/supplier-invitations", asyncHandler(listSupplierInvitations));
organiserRouter.post("/supplier-invitations/:id/revoke", asyncHandler(revokeSupplierInvitation));
organiserRouter.post("/campaigns/:id/submit", asyncHandler(submitOrganiserCampaign));
organiserRouter.post("/campaigns/:id/publish", asyncHandler(publishOrganiserCampaign));
// Rescue-window actions — doc §8. "Fulfil anyway below minimum" does not
// exist; the only paths out of RESCUE_WINDOW are a real top-up purchase,
// inviting more participants (no endpoint — just sharing), a single
// admin-approved extension, or ending the campaign into refunds.
organiserRouter.post("/campaigns/:id/rescue/top-up", asyncHandler(createOrganiserTopUp));
organiserRouter.post("/campaigns/:id/rescue/extension-request", asyncHandler(requestCampaignExtension));
organiserRouter.post("/campaigns/:id/rescue/end", asyncHandler(endCampaignRescue));
// M2 — spec §16 "POST /community-buys/:id/decision", AUTHORISE_THEN_CAPTURE
// mode only (DECISION_REQUIRED never occurs for a PLEDGE_THEN_CHARGE
// campaign, so this is a 409 there regardless).
organiserRouter.post("/campaigns/:id/decision", asyncHandler(decideCampaign));
organiserRouter.get("/campaigns/:id/participants", asyncHandler(listCampaignParticipants));
organiserRouter.get("/campaigns/:id/refund-progress", asyncHandler(getCampaignRefundProgress));
organiserRouter.get("/campaigns/:id/fulfilment", asyncHandler(getOrganiserFulfilment));
organiserRouter.post("/campaigns/:id/fulfilment/confirm-completion", asyncHandler(organiserConfirmFulfilmentCompletion));

// TEMPORARY compatibility shim for the currently-deployed mobile app — see
// the long comment in community-buy.controller.ts. Remove once the new
// mobile UI is live and legacy usage has dropped to zero in production.
organiserRouter.post("/campaigns/:id/fulfil-anyway", asyncHandler(legacyFulfilCampaignAnywayShim));
organiserRouter.post("/campaigns/:id/cancel", asyncHandler(legacyCancelFailedCampaignShim));

// Supplier — mounted at /supplier. Community Buy Workstream 1: the
// Supplier Centre landing (profile) and applying are open to ANY
// authenticated user — no Vendor, no verification, no role required (spec
// AT-03: opening Supplier Centre without approval shows a setup state, not
// an authorization error). Only genuinely protected supplier ACTIONS
// (accepting/declining obligations, fulfilment, payment views) require an
// approved SupplierAccount, via requireApprovedSupplier() below.
export const supplierRouter = Router();
supplierRouter.use(authenticate);
supplierRouter.get("/profile", asyncHandler(getMySupplierProfile));
supplierRouter.post("/applications", asyncHandler(applyAsSupplier));
// Stripe Connect onboarding (mandate item 2) — same gate as the profile/
// application routes above (any authenticated user with a SupplierAccount
// row): a supplier must be able to get payouts-ready while still under
// review, not only after approval.
supplierRouter.post("/stripe-connect/onboard", asyncHandler(onboardSupplierStripeConnect));
supplierRouter.get("/stripe-connect/status", asyncHandler(getSupplierStripeConnectStatus));
supplierRouter.post("/stripe-connect/refresh", asyncHandler(refreshSupplierStripeConnect));
supplierRouter.get("/campaigns", requireApprovedSupplier(), asyncHandler(listMySupplierCampaigns));
supplierRouter.post("/campaigns/:id/supplier-commitment", requireApprovedSupplier(), asyncHandler(confirmSupplierCommitment));
supplierRouter.post("/campaigns/:id/decline", requireApprovedSupplier(), asyncHandler(declineSupplierCommitment));
supplierRouter.get("/campaigns/:id/fulfilment", requireApprovedSupplier(), asyncHandler(getSupplierFulfilment));
supplierRouter.post("/campaigns/:id/fulfilment/confirm-inventory", requireApprovedSupplier(), asyncHandler(confirmFulfilmentInventory));
supplierRouter.post("/campaigns/:id/fulfilment/plan", requireApprovedSupplier(), asyncHandler(setFulfilmentPlan));
supplierRouter.post("/campaigns/:id/fulfilment/start-packing", requireApprovedSupplier(), asyncHandler(startFulfilmentPacking));
supplierRouter.post("/campaigns/:id/fulfilment/ready", requireApprovedSupplier(), asyncHandler(markFulfilmentReady));
supplierRouter.post("/campaigns/:id/fulfilment/dispatch", requireApprovedSupplier(), asyncHandler(markFulfilmentDispatched));
supplierRouter.post("/campaigns/:id/fulfilment/collect", requireApprovedSupplier(), asyncHandler(markFulfilmentCollected));
supplierRouter.get("/campaigns/:id/payment", requireApprovedSupplier(), asyncHandler(getMySupplierPayment));
// M2 — spec §16 "POST /community-buys/:id/reconfirm" and the
// AUTHORISE_THEN_CAPTURE-mode twin of the payment route above.
supplierRouter.post("/campaigns/:id/reconfirm", requireApprovedSupplier(), asyncHandler(reconfirmCampaign));
supplierRouter.get("/campaigns/:id/payout", requireApprovedSupplier(), asyncHandler(getMyCampaignPayout));

// M4 (spec §14.3, AT-39/40/41/44) — deliberately NOT gated by
// requireApprovedSupplier() (that gate is a blunt supplierState==="APPROVED"
// boolean, see require-capability.ts). Data access here is scope-aware
// (a RESTRICTED supplier with "fulfilment_access_preserved" must still get
// through) — communityBuyManifestService's own resolveForVendor/
// resolveForAccount does the real ownership + capture + control_scope
// check, campaign by campaign, on every call.
supplierRouter.get("/campaigns/:id/manifest", asyncHandler(getSupplierManifest));
supplierRouter.post("/campaigns/:id/contributions/:contributionId/contact", asyncHandler(sendSupplierContactMessage));
supplierRouter.get("/campaigns/:id/contributions/:contributionId/emergency-contact", asyncHandler(getSupplierEmergencyContact));
