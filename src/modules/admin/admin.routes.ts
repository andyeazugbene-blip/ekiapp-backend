import { accountTimeline, addNote, listNotes } from "./admin-notes.controller";
import { checkVendorClose, closeVendor } from "./admin-vendor-close";
import { getVendorStripeStatus, sendVendorStripeReminder } from "./admin-vendor-provider.controller";
/**
 * Admin routes — convention:
 *
 * - All routes are prefixed with /api/admin and require ADMIN role.
 * - GET   /resource          → list (paginated, cursor-based)
 * - POST  /resource          → create
 * - PATCH /resource/:id      → update fields
 * - PATCH /resource/:id/verb → state transition (approve, reject, complete, suspend, etc.)
 * - DELETE /resource/:id     → delete
 *
 * State transitions use PATCH with an action verb suffix (not POST) to stay RESTful.
 * All admin mutations are recorded in the AuditLog table.
 */
import { Router } from "express";

import { env } from "../../config/env";
import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireAdminPermission } from "../../middlewares/require-admin-permission";
import { requireAnyAdminPermission } from "../../middlewares/require-any-admin-permission";
import {
  getContentAsset, getContentReadUrl, getContentReviewCounts, listContentReviewQueue,
  listIdentityDocuments, moderateContentAsset,
} from "../uploads/content-review.controller";
import { require2fa } from "../../middlewares/require-2fa";
import { listAuditLogsV2, getAuditLogFacets, exportAuditLogs } from "./admin-audit-logs.controller";
import {
  getMyPermissions, listAdminAccounts, inviteAdmin, deactivateAdmin, reactivateAdmin,
  changeAdminRole, revokeOtherSessions, getIntegrationsStatus,
} from "./admin-team.controller";
import {
  adminApprovePayoutRequest, adminGetPayoutRequest,
  adminListPayoutRequests,
  adminMarkPayoutRequestPaid,
  adminRejectPayoutRequest,
} from "../payouts/payouts.controller";
import {
  adminListPendingApprovals,
  adminDecideApproval,
  adminListApprovalRules,
  adminUpsertApprovalRule,
} from "./admin-approvals.controller";
import {
  adminGetLedgerBalances,
  adminListReconciliationRuns,
  adminGetReconciliationRun,
  adminListOpenDifferences,
  adminRunReconciliation,
  adminRunCommunityBuyReconciliation,
  adminResolveReconciliationDifference,
  adminScanPaymentAnomalies,
  adminListPaymentAnomalies,
  adminReviewPaymentAnomaly,
  adminEscalatePaymentAnomaly,
} from "../ledger/ledger.controller";
import {
  adminScanFulfilmentDelays,
  adminListFulfilmentDelays,
  adminAddFulfilmentDelayNote,
  adminContactSupplierForDelay,
  adminResolveFulfilmentDelay,
  adminEscalateFulfilmentDelay,
} from "../community-buy/fulfilment-delay.controller";
import {
  createPromoCode as adminCreatePromoCode,
  listPromoCodes as adminListPromoCodes,
  updatePromoCode as adminUpdatePromoCode,
} from "../promos/promos.controller";
import {
  adminListReviews,
  adminModerateReview,
} from "../reviews/reviews.controller";
import {
  adminListReports,
  adminReviewReport,
} from "../reports/reports.controller";
import {
  adminGetDispute,
  adminListDisputes,
  adminResolveDispute,
} from "../paystack/dispute.controller";
import {
  adminListStripeDisputes,
  adminReviewStripeDispute,
} from "../stripe/stripe-disputes.controller";
import { adminAdjustTrustScore } from "../paystack/trust-score.controller";
import { getEscrowHealth, updateEscrowProvider } from "../paystack/escrow-health.controller";
import { listOperationalThresholds, updateOperationalThreshold, listPlatformFlags, upsertPlatformFlag, getSettingHistory } from "./admin-platform-settings.controller";
import {
  adminApproveVerificationReview,
  adminDeleteVerificationFiles,
  adminGetVerificationReview,
  adminListVerificationQueue,
  adminListPendingDocuments,
  adminRejectVerificationReview,
  adminReviewDocument,
} from "../verification/verification.controller";
import { asyncHandler } from "../../shared/utils/async-handler";
import { testRecordScope } from "../../shared/utils/test-records";
import { getActionCentre, searchAdmin, setTestFlag } from "./admin-dashboard-extras.controller";
import { AppError } from "../../shared/errors/app-error";
import {
  getAdminAnalytics,
  getAdminDashboard,
  listAuditLogs,
} from "./admin-dashboard.controller";
import { getAnalyticsGrowth, getAnalyticsOverview } from "./admin-analytics.controller";
import { getAnalyticsBuyers, getAnalyticsOrders, getAnalyticsVendors } from "./admin-analytics-phase2.controller";
import { getAnalyticsGeography, getAnalyticsPayments } from "./admin-analytics-phase3.controller";
import { getAdminRevenue } from "./admin-revenue.controller";
import {
  createDeliveryZone,
  deleteDeliveryZone,
  fixDeliveryZoneCurrencies,
  listAllDeliveryZones,
  updateDeliveryZone,
} from "./admin-delivery-zones.controller";
import {
  approveProduct,
  approveVendor,
  bulkApproveVendors,
  bulkRejectVendors,
  bulkSuspendVendors,
  deleteUser,
  deleteVendor,
  disableProduct,
  getOrder,
  getProduct,
  getUser,
  getVendor,
  getVendorStats,
  listOrders,
  listPayments,
  listProducts,
  listUsers,
  suspendUser,
  unsuspendUser,
  updateVendor,
  listVendors,
  listWalletTransactions, getPayment, getWalletTransaction,
  rejectVendor,
} from "./admin-listings.controller";
import {
  getAdminBroadcast, getChannelStatus, getCommsPause, listAdminBroadcasts, previewAdminBroadcastAudience,
  previewAdminBroadcastMessage, refreshAdminBroadcastReceipts, searchBroadcastRecipients, sendAdminBroadcast,
  setCommsPause, testSendAdminBroadcast,
} from "./admin-communications.controller";
import {
  getCommunicationStats, listCommunicationLogs, listCommunicationTemplates,
  seedCommunicationTemplates, updateCommunicationTemplate,
  createScheduledCommunication, listScheduledCommunications,
  cancelScheduledCommunication, runScheduledCommunications,
  updateScheduledCommunication, listCommunicationTemplateVersions,
} from "../communications/communication.controller";
import {
  assignAdminRole,
  createAdminRole,
  deleteAdminRole,
  listAdminRoles,
  removeAdminRoleAssignment,
  updateAdminRole,
} from "./admin-roles.controller";
import { completeOrder, processStuckOrder } from "./admin-orders.controller";
import { adminDisputeDecideAppeal, adminDisputePostMessage, adminDisputeRequestEvidence, adminDisputeV2Detail } from "../disputes/disputes.controller";
import { adminListOrderRefunds, adminRefundOrder } from "./admin-refunds.controller";
import {
  addVendorMarket,
  inviteVendor,
  listVendorMarkets,
  removeVendorMarket,
  setVendorMarketEnabled,
  suspendVendor,
  unsuspendVendor,
} from "./admin-vendors.controller";
import { getAdminAutomationSummary } from "../automation/automation.controller";
import {
  archiveAutomationRule, automationEmergencyStop, automationReleaseEmergencyStop, duplicateAutomationRule, getAutomationFailures,
  getAutomationPerformance, listAdminEvents, listAutomationRules, listAutomationRuns, pauseAutomationRule, resumeAutomationRule,
  retryAutomationRun, testAutomationRule, updateAutomationRule,
} from "../automation/automation-admin.controller";
import {
  adminApproveCampaign,
  adminApproveExtension,
  adminApproveCancellation,
  adminListCancellationRequests,
  adminRejectCancellation,
  adminListSupplierProposals,
  adminApproveSupplierProposal,
  adminRequestSupplierProposalChanges,
  adminApproveSupplierAccount,
  adminListSupplierAccounts,
  adminRestrictSupplierAccount,
  adminUnrestrictSupplierAccount,
  adminUnsuspendSupplierAccount,
  adminRevokeSupplierDataAccess,
  adminSearchDataAccessLog,
  adminRequestEmergencyDisclosure,
  adminRequestSupplierInformation,
  adminSuspendSupplierAccount,
  adminCloseSupplierAccount,
  adminGetFulfilmentEvents,
  adminCancelCampaign,
  adminListCampaignContributions,
  adminGetCampaignLedger,
  adminGetLedgerSummary,
  adminListExpiringHolds,
  adminScanStuckPayouts,
  adminListCommunityBuyPayouts,
  adminGetCommunityBuyPayout,
  adminGetCommunityBuyPayoutEligibility,
  adminMarkCommunityBuyPayoutReady,
  adminHoldCommunityBuyPayout,
  adminReleaseCommunityBuyPayout,
  adminListCommunityBuyOrganiserFees,
  adminGetCommunityBuyOrganiserFee,
  adminHoldCommunityBuyOrganiserFee,
  adminReleaseCommunityBuyOrganiserFee,
  adminSettleCommunityBuyOrganiserFee,
  adminListAttributionReviews,
  adminFlagAttributionForReview,
  adminResolveAttributionReview,
  adminGetSupportCase,
  adminHoldSupplierPayment,
  adminListCampaignsForReview,
  adminListExtensionRequests,
  adminListRecentlyClosedCampaigns,
  adminListMarketConfigurations,
  adminListPendingOrganisers,
  adminListPendingSuppliers,
  adminListRefunds,
  adminRequeryRefund,
  adminEscalateRefund,
  adminGetSupplierPaymentAggregate,
  adminListSupplierPayments,
  adminListSupportCases,
  adminListVerifiedOrganisers,
  adminListVerifiedSuppliers,
  adminPauseCampaign,
  adminReleaseSupplierPayment,
  adminResumeCampaign,
  adminSetCampaignIssueNotes,
  adminRejectCampaign,
  adminRejectExtension,
  adminRequestCampaignChanges,
  adminRestrictOrganiser,
  adminRestrictSupplier,
  adminUnrestrictOrganiser,
  adminUnrestrictSupplier,
  adminUpdateSupportCase,
  adminUpdateMarketConfiguration,
  adminCreateMarketConfiguration,
  adminUpdateMarketReadiness,
  adminSetMarketPayments,
  adminGetMarketHistory,
  adminGetSupplierAccount,
  adminExtendCampaignDeadline,
  adminMessageCampaignAudience,
  adminGetCampaignDetail,
  adminRejectSupplierAccount,
  adminVerifyOrganiser,
  adminGetOrganiserStripeConnectStatus,
  adminVerifySupplier,
  adminListOrganiserPayouts,
  adminReleaseOrganiserPayout,
  adminHoldOrganiserPayout,
} from "../community-buy/community-buy.controller";
import {
  adminCloseSupportConversation,
  adminDeescalateSupportConversation,
  adminEscalateSupportConversation,
  adminListSupportMessages,
  adminReopenSupportConversation,
  adminReplySupportConversation,
  adminGetSupportConversation,
  adminListSupportConversations,
} from "../messages/messages.controller";
import {
  disable2fa,
  regenerateBackupCodes,
  setup2fa,
  verify2fa,
} from "./admin-2fa.controller";
import {
  assignVendorPlan,
  deleteAdminPlan,
  listAdminPlans,
  upsertAdminPlan,
} from "../subscriptions/subscriptions.controller";
import {
  adminGetUploadReadUrl,
  adminListUploads,
} from "../uploads/uploads.controller";
import { adminRewardsRouter } from "../rewards/rewards.routes";
import { adminGiftCardsRouter } from "../gift-cards/gift-cards.routes";
import { adminRestoreProduct, adminUnpublishProduct } from "./admin-products.controller";
import { adminCampaignsRouter } from "../campaigns/campaigns.routes";
import { adminResetUsers } from "./admin-reset.controller";

export const adminRouter = Router();

// Dev/QA-only database reset+reseed utility — truncates nearly every table.
// Hard-blocked (404) whenever env.nodeEnv === "production", regardless of
// role, and still requires a real authenticated ADMIN session otherwise;
// never reachable by an unauthenticated request in any environment.
adminRouter.post(
  "/reset-users",
  authenticate,
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    if (env.nodeEnv === "production") {
      throw new AppError("Not found", 404);
    }
    await adminResetUsers(req, res);
  }),
);

adminRouter.use(authenticate, requireRole("ADMIN"));

// Dashboard & Analytics
// Test (QA/seed) records are excluded from these aggregates unless ?includeTest=true.
adminRouter.use(["/dashboard", "/analytics", "/revenue"], testRecordScope);
// Any admin: sections and KPIs are filtered by the viewer's own permissions inside the service.
adminRouter.get("/dashboard/action-centre", asyncHandler(getActionCentre));
// Global search: any admin; results are filtered per entity by the admin's read permissions.
adminRouter.get("/search", asyncHandler(searchAdmin));
// Test-record isolation (handbook 2.1 L139): flag/unflag QA data, reason required, audited.
adminRouter.patch("/users/:id/test-flag", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(setTestFlag("user")));
adminRouter.patch("/vendors/:id/test-flag", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(setTestFlag("vendor")));
adminRouter.patch("/orders/:id/test-flag", asyncHandler(requireAdminPermission("orders.mutate")), asyncHandler(setTestFlag("order")));
adminRouter.get("/dashboard", asyncHandler(requireAdminPermission("dashboard.read")), asyncHandler(getAdminDashboard));
adminRouter.get("/analytics", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAdminAnalytics));
// Canonical revenue chart endpoint. /revenue is kept as an alias.
adminRouter.get("/analytics/revenue", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAdminRevenue));
adminRouter.get("/analytics/overview", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAnalyticsOverview));
adminRouter.get("/analytics/growth", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAnalyticsGrowth));
adminRouter.get("/analytics/buyers", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAnalyticsBuyers));
adminRouter.get("/analytics/vendors", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAnalyticsVendors));
adminRouter.get("/analytics/orders", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAnalyticsOrders));
adminRouter.get("/analytics/payments", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAnalyticsPayments));
adminRouter.get("/analytics/geography", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAnalyticsGeography));
adminRouter.get("/revenue", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAdminRevenue));
adminRouter.get("/audit-logs", asyncHandler(requireAdminPermission("audit.read")), asyncHandler(listAuditLogsV2));
adminRouter.get("/audit-logs/facets", asyncHandler(requireAdminPermission("audit.read")), asyncHandler(getAuditLogFacets));
adminRouter.get("/audit-logs/export", asyncHandler(requireAdminPermission("audit.read")), asyncHandler(require2fa), asyncHandler(exportAuditLogs));
adminRouter.get("/automation/summary", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAdminAutomationSummary));
// Automation Centre (W11): rules, run history, failures, canonical events. Mutations: 2FA + required reason + audit.
adminRouter.get("/automation/rules", asyncHandler(requireAdminPermission("automation.read")), asyncHandler(listAutomationRules));
adminRouter.patch("/automation/rules/:id", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(updateAutomationRule));
adminRouter.post("/automation/rules/:id/pause", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(pauseAutomationRule));
adminRouter.post("/automation/rules/:id/resume", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(resumeAutomationRule));
adminRouter.post("/automation/rules/:id/archive", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(archiveAutomationRule));
adminRouter.post("/automation/rules/:id/duplicate", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(duplicateAutomationRule));
adminRouter.post("/automation/rules/:id/test", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(testAutomationRule));
adminRouter.post("/automation/emergency-stop", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(automationEmergencyStop));
adminRouter.post("/automation/emergency-stop/release", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(automationReleaseEmergencyStop));
adminRouter.get("/automation/runs", asyncHandler(requireAdminPermission("automation.read")), asyncHandler(listAutomationRuns));
adminRouter.post("/automation/runs/:id/retry", asyncHandler(requireAdminPermission("automation.mutate")), asyncHandler(require2fa), asyncHandler(retryAutomationRun));
adminRouter.get("/automation/failures", asyncHandler(requireAdminPermission("automation.read")), asyncHandler(getAutomationFailures));
adminRouter.get("/automation/performance", asyncHandler(requireAdminPermission("automation.read")), asyncHandler(getAutomationPerformance));
adminRouter.get("/events", asyncHandler(requireAdminPermission("automation.read")), asyncHandler(listAdminEvents));
// Regular Delivery admin actions (list/retry-payment/force-cancel/contact-buyer/
// change-frequency/price-change remediation) live under adminSubscriptionsRouter
// and adminRenewalsRouter (src/modules/regular-deliveries/regular-deliveries.routes.ts,
// mounted at /admin/subscriptions and /admin/renewals in src/routes/index.ts) —
// not duplicated here.

// Community Buy
adminRouter.get("/community-campaigns/review", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListCampaignsForReview));
adminRouter.get("/community-campaigns/closed", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListRecentlyClosedCampaigns));
adminRouter.post("/community-campaigns/:id/approve", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminApproveCampaign));
adminRouter.post("/community-campaigns/:id/request-changes", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminRequestCampaignChanges));
adminRouter.post("/community-campaigns/:id/reject", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminRejectCampaign));
adminRouter.post("/community-campaigns/:id/pause", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminPauseCampaign));
adminRouter.get("/community-campaigns/:id/admin-detail", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetCampaignDetail));
adminRouter.post("/community-campaigns/:id/extend-deadline", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminExtendCampaignDeadline));
adminRouter.post("/community-campaigns/:id/message", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminMessageCampaignAudience));
adminRouter.post("/community-campaigns/:id/resume", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminResumeCampaign));
adminRouter.post("/community-campaigns/:id/issue-notes", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminSetCampaignIssueNotes));
// Cancel/end — Phase 9 (REQ-CB-A-002). No 2FA: matches reject/pause/resume,
// since cancel is only ever reachable pre-charge (see the service method's
// own comment) — no money moves, so it sits in the same tier as those,
// not the 2FA-gated tier reserved for refund/transfer actions.
// Phase 8 — can trigger a real refund (AT-25: a PAYMENT_CAPTURE-status
// campaign may already have PAID contributions), matching every other
// refund/release-adjacent Community Buy admin action in this file, which
// all already require 2FA.
adminRouter.post("/community-campaigns/:id/cancel", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminCancelCampaign));
adminRouter.get("/community-campaigns/:id/contributions", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListCampaignContributions));
adminRouter.get("/community-buy/organisers/pending", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListPendingOrganisers));
adminRouter.post("/community-buy/organisers/:id/verify", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminVerifyOrganiser));
// Stripe Connect production hardening — read-only from the admin's
// perspective (no business-state mutation), but still a real live Stripe
// API call an admin is directing, so gated + audited like the mutate
// actions above rather than the plain .read list/detail routes.
adminRouter.get("/community-buy/organisers/:id/stripe-connect/status", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminGetOrganiserStripeConnectStatus));
adminRouter.get("/community-buy/suppliers/pending", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListPendingSuppliers));
adminRouter.post("/community-buy/suppliers/:id/verify", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminVerifySupplier));
adminRouter.get("/community-buy/refunds", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListRefunds));
adminRouter.post("/community-buy/refunds/:id/requery", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminRequeryRefund));
adminRouter.post("/community-buy/refunds/:id/escalate", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminEscalateRefund));
adminRouter.get("/community-buy/extension-requests", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListExtensionRequests));
adminRouter.post("/community-buy/extension-requests/:id/approve", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminApproveExtension));
adminRouter.post("/community-buy/extension-requests/:id/reject", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRejectExtension));
// Phase 4 (cancellation under review) — approve is 2FA-free but can be
// four-eyes-gated via AdminApprovalRule("community_buy.cancellation_approval"),
// same as supplier-payment/organiser-payout release.
adminRouter.get("/community-buy/cancellation-requests", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListCancellationRequests));
adminRouter.post("/community-buy/cancellation-requests/:id/approve", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminApproveCancellation));
adminRouter.post("/community-buy/cancellation-requests/:id/reject", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRejectCancellation));
// Phase 5 (organiser<->supplier negotiation) — Eki's review queue for
// supplier-submitted proposals, gating them before the organiser ever sees one.
adminRouter.get("/community-buy/supplier-proposals", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListSupplierProposals));
adminRouter.post("/community-buy/supplier-proposals/:id/approve", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminApproveSupplierProposal));
adminRouter.post("/community-buy/supplier-proposals/:id/request-changes", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRequestSupplierProposalChanges));
adminRouter.get("/community-buy/supplier-payments", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListSupplierPayments));
adminRouter.get("/community-buy/supplier-payments/aggregate", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetSupplierPaymentAggregate));
adminRouter.post("/community-campaigns/:id/supplier-payment/release", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminReleaseSupplierPayment));
adminRouter.post("/community-campaigns/:id/supplier-payment/hold", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminHoldSupplierPayment));
adminRouter.get("/community-buy/organiser-payouts", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListOrganiserPayouts));
adminRouter.post("/community-campaigns/:id/organiser-payout/release", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminReleaseOrganiserPayout));
adminRouter.post("/community-campaigns/:id/organiser-payout/hold", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminHoldOrganiserPayout));

// M2 — AUTHORISE_THEN_CAPTURE payout admin (CommunityBuyPayout). Same
// permission/2FA gating as the CampaignSupplierPayment routes above; the
// release route additionally refuses server-side (503
// PAYOUT_CUSTODY_NOT_CONFIRMED) unless payout custody has been explicitly
// confirmed — see campaign-payout.service.ts.
adminRouter.get("/community-buy/holds/expiring", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListExpiringHolds));
adminRouter.get("/community-buy/payouts/stuck-scan", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminScanStuckPayouts));
adminRouter.get("/community-buy/payouts", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListCommunityBuyPayouts));
adminRouter.get("/community-campaigns/:id/payout", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetCommunityBuyPayout));
adminRouter.get("/community-campaigns/:id/payout/eligibility", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetCommunityBuyPayoutEligibility));
adminRouter.post("/community-campaigns/:id/payout/mark-ready", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminMarkCommunityBuyPayoutReady));
adminRouter.post("/community-campaigns/:id/payout/hold", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminHoldCommunityBuyPayout));
adminRouter.post("/community-campaigns/:id/payout/release", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminReleaseCommunityBuyPayout));

// M7 — CommunityBuyOrganiserFee admin (spec §13.3/§15.6). Same permission
// gating as the payout routes above; settle is 2FA-gated even though the
// two non-cash routes never move money, since it's still a financial-state
// terminal transition — same caution level as marking a payout ready.
adminRouter.get("/community-buy/organiser-fees", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListCommunityBuyOrganiserFees));
adminRouter.get("/community-campaigns/:id/organiser-fee", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetCommunityBuyOrganiserFee));
adminRouter.post("/community-campaigns/:id/organiser-fee/hold", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminHoldCommunityBuyOrganiserFee));
adminRouter.post("/community-campaigns/:id/organiser-fee/release", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminReleaseCommunityBuyOrganiserFee));
adminRouter.post("/community-campaigns/:id/organiser-fee/settle", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminSettleCommunityBuyOrganiserFee));

// M7 — attribution review (spec §14.5, AT-45/AT-46). Manual admin
// investigation only; never auto-diverts a reward to another organiser.
adminRouter.get("/community-buy/attribution-reviews", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListAttributionReviews));
adminRouter.post("/community-buy/participants/:id/attribution/flag", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminFlagAttributionForReview));
adminRouter.post("/community-buy/participants/:id/attribution/resolve", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminResolveAttributionReview));

// Four-eyes approvals (architecture doc §7) — generic across gated action
// types. Deciding a specific pending approval uses its own approvals.read/
// approvals.decide permissions (granted to the operational roles whose
// mutate actions actually trigger four-eyes: Refund Ops, Payment Ops,
// Campaign Reviewer, Supplier Settlement) so that a *different* operational
// admin — not only a Super Administrator — can be the second pair of eyes.
// Previously this reused roles.read/roles.mutate, which none of those
// operational roles hold, meaning only Super Administrator accounts could
// ever decide an approval — defeating the point of a role-gated four-eyes
// control. approval-rules (the threshold policy itself, not an individual
// decision) intentionally stays on roles.read/roles.mutate: changing what
// requires approval is a higher-privilege, authority-level setting.
adminRouter.get("/approvals", asyncHandler(requireAdminPermission("approvals.read")), asyncHandler(adminListPendingApprovals));
adminRouter.post("/approvals/:id/decide", asyncHandler(requireAdminPermission("approvals.decide")), asyncHandler(require2fa), asyncHandler(adminDecideApproval));
adminRouter.get("/approval-rules", asyncHandler(requireAdminPermission("roles.read")), asyncHandler(adminListApprovalRules));
adminRouter.put("/approval-rules/:actionType", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(adminUpsertApprovalRule));
adminRouter.get("/community-buy/markets", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListMarketConfigurations));
adminRouter.post("/community-buy/markets", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminCreateMarketConfiguration));
adminRouter.patch("/community-buy/markets/:id", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminUpdateMarketConfiguration));
adminRouter.patch("/community-buy/markets/:id/readiness", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminUpdateMarketReadiness));
adminRouter.post("/community-buy/markets/:id/payments", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminSetMarketPayments));
adminRouter.get("/community-buy/markets/:id/history", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetMarketHistory));
adminRouter.get("/community-buy/ledger", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetLedgerSummary));
adminRouter.get("/community-campaigns/:id/ledger", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetCampaignLedger));

// Real double-entry ledger + provider reconciliation — distinct from the
// Community Buy-specific summary above, which reads CampaignContribution/
// CampaignRefund/CampaignSupplierPayment directly, not LedgerAccount/
// LedgerEntry. Read-only except the two explicitly-modeled actions the
// schema itself supports: running a reconciliation and resolving a
// difference (ReconciliationDifference.status/resolvedAt already exist).
adminRouter.get("/ledger/balances", asyncHandler(requireAdminPermission("audit.read")), asyncHandler(adminGetLedgerBalances));
adminRouter.get("/ledger/reconciliation-runs", asyncHandler(requireAdminPermission("audit.read")), asyncHandler(adminListReconciliationRuns));
adminRouter.get("/ledger/reconciliation-runs/:id", asyncHandler(requireAdminPermission("audit.read")), asyncHandler(adminGetReconciliationRun));
adminRouter.post("/ledger/reconciliation-runs", asyncHandler(requireAdminPermission("payments.mutate")), asyncHandler(adminRunReconciliation));
adminRouter.post("/ledger/community-buy-reconciliation-runs", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRunCommunityBuyReconciliation));
adminRouter.get("/ledger/differences", asyncHandler(requireAdminPermission("audit.read")), asyncHandler(adminListOpenDifferences));
adminRouter.post("/ledger/differences/:id/resolve", asyncHandler(requireAdminPermission("payments.mutate")), asyncHandler(adminResolveReconciliationDifference));

// Duplicate-payment / financial-inconsistency queue (architecture doc §15.3).
adminRouter.post("/payment-anomalies/scan", asyncHandler(requireAdminPermission("reports.mutate")), asyncHandler(adminScanPaymentAnomalies));
adminRouter.get("/payment-anomalies", asyncHandler(requireAdminPermission("reports.read")), asyncHandler(adminListPaymentAnomalies));
adminRouter.post("/payment-anomalies/:id/review", asyncHandler(requireAdminPermission("reports.mutate")), asyncHandler(adminReviewPaymentAnomaly));
adminRouter.post("/payment-anomalies/:id/escalate", asyncHandler(requireAdminPermission("reports.mutate")), asyncHandler(adminEscalatePaymentAnomaly));

// Supplier-fulfilment delay queue (architecture doc §15.3).
adminRouter.post("/fulfilment-delays/scan", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminScanFulfilmentDelays));
adminRouter.get("/fulfilment-delays", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListFulfilmentDelays));
adminRouter.post("/fulfilment-delays/:id/note", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminAddFulfilmentDelayNote));
adminRouter.post("/fulfilment-delays/:id/contact-supplier", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminContactSupplierForDelay));
adminRouter.post("/fulfilment-delays/:id/resolve", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminResolveFulfilmentDelay));
adminRouter.post("/fulfilment-delays/:id/escalate", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminEscalateFulfilmentDelay));
// M5 — the append-only fulfilment evidence timeline.
adminRouter.get("/community-campaigns/:id/fulfilment-events", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetFulfilmentEvents));
adminRouter.get("/community-buy/organisers", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListVerifiedOrganisers));
adminRouter.post("/community-buy/organisers/:id/restrict", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRestrictOrganiser));
adminRouter.post("/community-buy/organisers/:id/unrestrict", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminUnrestrictOrganiser));
adminRouter.get("/community-buy/suppliers", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListVerifiedSuppliers));
adminRouter.post("/community-buy/suppliers/:id/restrict", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRestrictSupplier));
adminRouter.post("/community-buy/suppliers/:id/unrestrict", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminUnrestrictSupplier));
// Community Buy Workstream 1 — admin actions on the new, no-Vendor-required
// SupplierAccount (distinct from /community-buy/suppliers above, which
// still operates on the legacy Vendor-keyed SupplierProfile).
adminRouter.get("/community-buy/supplier-accounts", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListSupplierAccounts));
adminRouter.get("/community-buy/supplier-accounts/:id", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetSupplierAccount));
adminRouter.post("/community-buy/supplier-accounts/:id/reject", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRejectSupplierAccount));
adminRouter.post("/community-buy/supplier-accounts/:id/approve", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminApproveSupplierAccount));
adminRouter.post("/community-buy/supplier-accounts/:id/restrict", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRestrictSupplierAccount));
adminRouter.post("/community-buy/supplier-accounts/:id/unrestrict", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminUnrestrictSupplierAccount));
// M5 (spec §6.4, §10.1/§10.2 step 6) — request-information mirrors restrict's severity (no 2FA); suspend/close are harder to reverse (close is permanent) and always revoke data access, so both require 2FA like revoke-data-access below.
adminRouter.post("/community-buy/supplier-accounts/:id/request-information", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminRequestSupplierInformation));
adminRouter.post("/community-buy/supplier-accounts/:id/suspend", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminSuspendSupplierAccount));
adminRouter.post("/community-buy/supplier-accounts/:id/unsuspend", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminUnsuspendSupplierAccount));
adminRouter.post("/community-buy/supplier-accounts/:id/close", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminCloseSupplierAccount));
// M4 — delivery/privacy admin controls (spec §14, §19, AT-42/43).
adminRouter.post("/community-buy/supplier-accounts/:id/revoke-data-access", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminRevokeSupplierDataAccess));
adminRouter.get("/community-buy/data-access-log", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminSearchDataAccessLog));
adminRouter.post("/community-campaigns/:id/contributions/:contributionId/emergency-disclosure", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(require2fa), asyncHandler(adminRequestEmergencyDisclosure));
adminRouter.get("/community-buy/support-cases", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminListSupportCases));
adminRouter.get("/community-buy/support-cases/:id", asyncHandler(requireAdminPermission("community_buy.read")), asyncHandler(adminGetSupportCase));
adminRouter.patch("/community-buy/support-cases/:id", asyncHandler(requireAdminPermission("community_buy.mutate")), asyncHandler(adminUpdateSupportCase));

// Listings
adminRouter.get("/users", asyncHandler(requireAdminPermission("users.read")), asyncHandler(listUsers));
adminRouter.get("/users/:id", asyncHandler(requireAdminPermission("users.read")), asyncHandler(getUser));
adminRouter.get("/vendors/stats", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(getVendorStats));
adminRouter.get("/vendors", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(listVendors));
adminRouter.get("/vendors/:id/stripe-status", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(getVendorStripeStatus));
adminRouter.post("/vendors/:id/stripe-reminder", asyncHandler(requireAdminPermission("verification.mutate")), asyncHandler(sendVendorStripeReminder));
adminRouter.get("/vendors/:id", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(getVendor));
adminRouter.patch("/vendors/:id", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(updateVendor));
adminRouter.get("/users/:id/notes", asyncHandler(requireAdminPermission("users.read")), asyncHandler(listNotes("User")));
adminRouter.post("/users/:id/notes", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(addNote("User")));
adminRouter.get("/users/:id/timeline", asyncHandler(requireAdminPermission("users.read")), asyncHandler(accountTimeline("User")));
adminRouter.get("/vendors/:id/notes", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(listNotes("Vendor")));
adminRouter.post("/vendors/:id/notes", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(addNote("Vendor")));
adminRouter.get("/vendors/:id/timeline", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(accountTimeline("Vendor")));
adminRouter.get("/vendors/:id/close-check", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(checkVendorClose));
adminRouter.post("/vendors/:id/close", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(require2fa), asyncHandler(closeVendor));
adminRouter.post("/vendors/bulk-approve", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(bulkApproveVendors));
adminRouter.post("/vendors/bulk-reject", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(bulkRejectVendors));
adminRouter.post("/vendors/bulk-suspend", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(require2fa), asyncHandler(bulkSuspendVendors));
adminRouter.post("/vendors/invite", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(inviteVendor));
adminRouter.get("/products", asyncHandler(requireAdminPermission("products.read")), asyncHandler(listProducts));
adminRouter.get("/products/:id", asyncHandler(requireAdminPermission("products.read")), asyncHandler(getProduct));
adminRouter.get("/orders", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(listOrders));
adminRouter.get("/orders/:id", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(getOrder));
adminRouter.get("/payments", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(listPayments));
adminRouter.get("/payments/:id", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(getPayment));
adminRouter.get("/wallet-transactions/:id", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(getWalletTransaction));
adminRouter.get("/wallet-transactions", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(listWalletTransactions));

// Communications
// Handbook 6.2: send/schedule needs 2FA + reason + prior test-send proof (validated in the controller).
adminRouter.post("/broadcasts", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(require2fa), asyncHandler(sendAdminBroadcast));
adminRouter.get("/broadcasts", asyncHandler(requireAdminPermission("communications.read")), asyncHandler(listAdminBroadcasts));
adminRouter.post("/broadcasts/preview", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(previewAdminBroadcastMessage));
adminRouter.get("/broadcasts/audience-count", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(previewAdminBroadcastAudience));
adminRouter.get("/broadcasts/:id", asyncHandler(requireAdminPermission("communications.read")), asyncHandler(getAdminBroadcast));
adminRouter.post("/broadcasts/:id/check-receipts", asyncHandler(requireAdminPermission("communications.read")), asyncHandler(refreshAdminBroadcastReceipts));
adminRouter.get("/communications/channel-status", asyncHandler(requireAdminPermission("communications.read")), asyncHandler(getChannelStatus));
adminRouter.get("/communications/recipients", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(searchBroadcastRecipients));
// Emergency pause: Super Administrator only ("admin.*"), 2FA, reason, audited.
adminRouter.get("/communications/pause", asyncHandler(requireAdminPermission("communications.read")), asyncHandler(getCommsPause));
adminRouter.post("/communications/pause", asyncHandler(requireAdminPermission("admin.*")), asyncHandler(require2fa), asyncHandler(setCommsPause));
adminRouter.get("/communications/templates/:key/versions", asyncHandler(requireAdminPermission("communications.read")), asyncHandler(listCommunicationTemplateVersions));
adminRouter.post("/broadcasts/test-send", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(testSendAdminBroadcast));
adminRouter.get("/communications/stats", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(getCommunicationStats));
adminRouter.get("/communications", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(listCommunicationLogs));
adminRouter.get("/communications/templates", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(listCommunicationTemplates));
adminRouter.post("/communications/templates/seed", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(seedCommunicationTemplates));
adminRouter.patch("/communications/templates/:key", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(updateCommunicationTemplate));
// Scheduled communications
adminRouter.post("/communications/scheduled", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(createScheduledCommunication));
adminRouter.get("/communications/scheduled", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(listScheduledCommunications));
adminRouter.patch("/communications/scheduled/:id/cancel", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(cancelScheduledCommunication));
adminRouter.patch("/communications/scheduled/:id", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(updateScheduledCommunication));
adminRouter.post("/communications/run-scheduled", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(runScheduledCommunications));

// In-app support messaging — the shared inbox for buyer-initiated support
// conversations (client decision 2026-09-22). Replying/reading a thread's
// messages/marking read reuse the generic /api/conversations/:id/* routes
// (messages.routes.ts) directly — the authorization change that permits any
// support.mutate admin there, not a fixed participant, lives in
// messages.service.ts's assertConversationAccess().
adminRouter.get("/support/conversations", asyncHandler(requireAdminPermission("support.read")), asyncHandler(adminListSupportConversations));
adminRouter.get("/support/conversations/:id", asyncHandler(requireAdminPermission("support.read")), asyncHandler(adminGetSupportConversation));
// Thread incl. internal notes (the generic participant route never returns them), reply/note, lifecycle.
adminRouter.get("/support/conversations/:id/messages", asyncHandler(requireAdminPermission("support.read")), asyncHandler(adminListSupportMessages));
adminRouter.post("/support/conversations/:id/messages", asyncHandler(requireAdminPermission("support.mutate")), asyncHandler(adminReplySupportConversation));
adminRouter.patch("/support/conversations/:id/close", asyncHandler(requireAdminPermission("support.mutate")), asyncHandler(adminCloseSupportConversation));
adminRouter.patch("/support/conversations/:id/reopen", asyncHandler(requireAdminPermission("support.mutate")), asyncHandler(adminReopenSupportConversation));
adminRouter.patch("/support/conversations/:id/escalate", asyncHandler(requireAdminPermission("support.mutate")), asyncHandler(adminEscalateSupportConversation));
adminRouter.patch("/support/conversations/:id/deescalate", asyncHandler(requireAdminPermission("support.mutate")), asyncHandler(adminDeescalateSupportConversation));

// Admin role management
adminRouter.get("/roles", asyncHandler(requireAdminPermission("roles.read")), asyncHandler(listAdminRoles));
adminRouter.post("/roles", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(createAdminRole));
adminRouter.patch("/roles/:id", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(updateAdminRole));
adminRouter.delete("/roles/:id", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(deleteAdminRole));
adminRouter.post("/roles/:id/assignments", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(assignAdminRole));
adminRouter.delete("/role-assignments/:id", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(removeAdminRoleAssignment));

// Vendor moderation
adminRouter.patch("/vendors/:id/approve", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(approveVendor));
adminRouter.patch("/vendors/:id/reject", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(rejectVendor));

// Product moderation
adminRouter.patch("/products/:id/approve", asyncHandler(requireAdminPermission("products.mutate")), asyncHandler(approveProduct));
adminRouter.patch("/products/:id/disable", asyncHandler(requireAdminPermission("products.mutate")), asyncHandler(require2fa), asyncHandler(disableProduct));
adminRouter.post("/products/:id/unpublish", asyncHandler(requireAdminPermission("products.mutate")), asyncHandler(require2fa), asyncHandler(adminUnpublishProduct));
adminRouter.post("/products/:id/restore", asyncHandler(requireAdminPermission("products.mutate")), asyncHandler(adminRestoreProduct));

// Order management
// 2FA-gated (acceptance audit fix): both mutate payment/order state and
// credit or release real vendor wallet funds — the same class of action as
// /orders/:id/refund below, which already required it.
adminRouter.post("/orders/:id/force-process", asyncHandler(requireAdminPermission("orders.mutate")), asyncHandler(require2fa), asyncHandler(processStuckOrder));
adminRouter.patch("/orders/:id/complete", asyncHandler(requireAdminPermission("orders.mutate")), asyncHandler(require2fa), asyncHandler(completeOrder));

// Payout management
adminRouter.get("/payout-requests/:id", asyncHandler(requireAdminPermission("payouts.read")), asyncHandler(adminGetPayoutRequest));
adminRouter.get("/payout-requests", asyncHandler(requireAdminPermission("payouts.read")), asyncHandler(adminListPayoutRequests));
adminRouter.patch("/payout-requests/:id/approve", asyncHandler(requireAdminPermission("payouts.mutate")), asyncHandler(require2fa), asyncHandler(adminApprovePayoutRequest));
adminRouter.patch("/payout-requests/:id/reject", asyncHandler(requireAdminPermission("payouts.mutate")), asyncHandler(require2fa), asyncHandler(adminRejectPayoutRequest));

// Verification document review
adminRouter.get("/verifications", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(adminListVerificationQueue));
adminRouter.get("/verifications/:id", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(adminGetVerificationReview));
adminRouter.patch("/verifications/:id/approve", asyncHandler(requireAdminPermission("verification.mutate")), asyncHandler(adminApproveVerificationReview));
adminRouter.patch("/verifications/:id/reject", asyncHandler(requireAdminPermission("verification.mutate")), asyncHandler(adminRejectVerificationReview));
adminRouter.delete("/verifications/:id/files", asyncHandler(requireAdminPermission("verification.mutate")), asyncHandler(adminDeleteVerificationFiles));
adminRouter.get("/verification-documents", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(adminListPendingDocuments));
adminRouter.patch("/verification-documents/:id/review", asyncHandler(requireAdminPermission("verification.mutate")), asyncHandler(adminReviewDocument));
adminRouter.get("/uploads", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(adminListUploads));
adminRouter.get("/uploads/:id/read-url", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(adminGetUploadReadUrl));

// Delivery zone management (global)
adminRouter.get("/delivery-zones", asyncHandler(requireAdminPermission("delivery_zones.read")), asyncHandler(listAllDeliveryZones));
adminRouter.post("/delivery-zones", asyncHandler(requireAdminPermission("delivery_zones.mutate")), asyncHandler(createDeliveryZone));
adminRouter.patch("/delivery-zones/:id", asyncHandler(requireAdminPermission("delivery_zones.mutate")), asyncHandler(updateDeliveryZone));
adminRouter.delete("/delivery-zones/:id", asyncHandler(requireAdminPermission("delivery_zones.mutate")), asyncHandler(deleteDeliveryZone));
adminRouter.post("/delivery-zones/fix-currencies", asyncHandler(requireAdminPermission("delivery_zones.mutate")), asyncHandler(fixDeliveryZoneCurrencies));

// Promo code management
adminRouter.get("/promo-codes", asyncHandler(requireAdminPermission("promos.read")), asyncHandler(adminListPromoCodes));
adminRouter.post("/promo-codes", asyncHandler(requireAdminPermission("promos.mutate")), asyncHandler(adminCreatePromoCode));
adminRouter.patch("/promo-codes/:id", asyncHandler(requireAdminPermission("promos.mutate")), asyncHandler(adminUpdatePromoCode));

// Subscription plan management
adminRouter.get("/subscription-plans", asyncHandler(requireAdminPermission("subscriptions.read")), asyncHandler(listAdminPlans));
adminRouter.post("/subscription-plans", asyncHandler(requireAdminPermission("subscriptions.mutate")), asyncHandler(upsertAdminPlan));
adminRouter.patch("/subscription-plans/:plan", asyncHandler(requireAdminPermission("subscriptions.mutate")), asyncHandler(upsertAdminPlan));
adminRouter.delete("/subscription-plans/:id", asyncHandler(requireAdminPermission("subscriptions.mutate")), asyncHandler(deleteAdminPlan));
adminRouter.patch("/vendors/:id/seller-plan", asyncHandler(requireAdminPermission("subscriptions.mutate")), asyncHandler(assignVendorPlan));

// Review moderation
adminRouter.get("/reviews", asyncHandler(requireAdminPermission("reviews.read")), asyncHandler(adminListReviews));
adminRouter.patch("/reviews/:id/moderate", asyncHandler(requireAdminPermission("reviews.mutate")), asyncHandler(adminModerateReview));

// Content reports
// Content Review (handbook 7). content.* is the new gate; reports.* roles keep working.
adminRouter.get("/reports", asyncHandler(requireAnyAdminPermission("content.read", "reports.read")), asyncHandler(adminListReports));
adminRouter.patch("/reports/:id", asyncHandler(requireAnyAdminPermission("content.mutate", "reports.mutate")), asyncHandler(adminReviewReport));
adminRouter.get("/content-review/counts", asyncHandler(requireAnyAdminPermission("content.read", "reports.read")), asyncHandler(getContentReviewCounts));
adminRouter.get("/content-review/queue", asyncHandler(requireAdminPermission("content.read")), asyncHandler(listContentReviewQueue));
adminRouter.get("/content-review/identity-documents", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(listIdentityDocuments));
adminRouter.get("/content-review/assets/:id", asyncHandler(requireAnyAdminPermission("content.read", "verification.read")), asyncHandler(getContentAsset));
adminRouter.get("/content-review/assets/:id/read-url", asyncHandler(requireAnyAdminPermission("content.read", "verification.read")), asyncHandler(getContentReadUrl));
adminRouter.post("/content-review/assets/:id/:action", asyncHandler(requireAdminPermission("content.mutate")), asyncHandler(moderateContentAsset));

// Escrow disputes
adminRouter.get("/disputes", asyncHandler(requireAdminPermission("disputes.read")), asyncHandler(adminListDisputes));
adminRouter.get("/disputes/:id", asyncHandler(requireAdminPermission("disputes.read")), asyncHandler(adminGetDispute));
adminRouter.get("/disputes/:id/case", asyncHandler(requireAdminPermission("disputes.read")), asyncHandler(adminDisputeV2Detail));
adminRouter.post("/disputes/:id/messages", asyncHandler(requireAdminPermission("disputes.mutate")), asyncHandler(adminDisputePostMessage));
adminRouter.post("/disputes/:id/request-evidence", asyncHandler(requireAdminPermission("disputes.mutate")), asyncHandler(adminDisputeRequestEvidence));
adminRouter.post("/disputes/:id/appeal-decision", asyncHandler(requireAdminPermission("disputes.mutate")), asyncHandler(require2fa), asyncHandler(adminDisputeDecideAppeal));
adminRouter.patch("/disputes/:id/resolve", asyncHandler(requireAdminPermission("disputes.mutate")), asyncHandler(require2fa), asyncHandler(adminResolveDispute));

// Real Stripe chargebacks (architecture doc §15.3 "Chargebacks") — distinct
// from the buyer/vendor Dispute model above.
adminRouter.get("/stripe-disputes", asyncHandler(requireAdminPermission("disputes.read")), asyncHandler(adminListStripeDisputes));
adminRouter.patch("/stripe-disputes/:id/review", asyncHandler(requireAdminPermission("disputes.mutate")), asyncHandler(adminReviewStripeDispute));

// Trust score management
adminRouter.patch("/users/:id/trust-score", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(adminAdjustTrustScore));
adminRouter.patch("/users/:id/suspend", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(require2fa), asyncHandler(suspendUser));
adminRouter.patch("/users/:id/unsuspend", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(require2fa), asyncHandler(unsuspendUser));
adminRouter.delete("/users/:id", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(require2fa), asyncHandler(deleteUser));

// Escrow health monitoring
adminRouter.get("/escrow/health", asyncHandler(requireAdminPermission("escrow.read")), asyncHandler(getEscrowHealth));
adminRouter.patch("/escrow/providers/:id", asyncHandler(requireAdminPermission("settings.mutate")), asyncHandler(require2fa), asyncHandler(updateEscrowProvider));

// Admin-managed operational thresholds (client decision 2026-09-22) — real
// persisted settings, not .env values. Reversible, non-financial-custody
// operational config, matching the same permission tier as the escrow
// provider settings above — no 2FA per the client's explicit "do not add
// unnecessary 2FA" instruction.
adminRouter.get("/settings/operational-thresholds", asyncHandler(requireAdminPermission("settings.read")), asyncHandler(listOperationalThresholds));
adminRouter.get("/settings/flags", asyncHandler(requireAdminPermission("settings.read")), asyncHandler(listPlatformFlags));
adminRouter.put("/settings/flags/:key", asyncHandler(requireAdminPermission("settings.mutate")), asyncHandler(require2fa), asyncHandler(upsertPlatformFlag));
adminRouter.get("/settings/history/:key", asyncHandler(requireAdminPermission("settings.read")), asyncHandler(getSettingHistory));
adminRouter.get("/integrations/status", asyncHandler(requireAdminPermission("settings.read")), asyncHandler(getIntegrationsStatus));
adminRouter.get("/me/permissions", asyncHandler(getMyPermissions));
adminRouter.post("/me/sessions/revoke-others", asyncHandler(revokeOtherSessions));
adminRouter.get("/admins", asyncHandler(requireAdminPermission("roles.read")), asyncHandler(listAdminAccounts));
adminRouter.post("/admins/invite", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(inviteAdmin));
adminRouter.post("/admins/:id/deactivate", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(deactivateAdmin));
adminRouter.post("/admins/:id/reactivate", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(reactivateAdmin));
adminRouter.put("/admins/:id/role", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(require2fa), asyncHandler(changeAdminRole));
adminRouter.patch("/settings/operational-thresholds/:key", asyncHandler(requireAdminPermission("settings.mutate")), asyncHandler(require2fa), asyncHandler(updateOperationalThreshold));

// Rewards / Gifts management
adminRouter.use("/rewards", adminRewardsRouter);

// Gift Cards management
adminRouter.use("/gift-cards", adminGiftCardsRouter);
adminRouter.use("/campaigns", adminCampaignsRouter);

// Dev utilities


// ─── 2FA Management ─────────────────────────────────────────────────────────
adminRouter.post("/2fa/setup", asyncHandler(setup2fa));
adminRouter.post("/2fa/verify", asyncHandler(verify2fa));
adminRouter.post("/2fa/disable", asyncHandler(disable2fa));
adminRouter.post("/2fa/backup-codes/regenerate", asyncHandler(regenerateBackupCodes));

// ─── Sensitive operations requiring 2FA (if enabled) ────────────────────────
adminRouter.get("/refunds", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(adminListOrderRefunds));
adminRouter.post("/orders/:id/refund", asyncHandler(requireAdminPermission("payments.mutate")), asyncHandler(require2fa), asyncHandler(adminRefundOrder));
adminRouter.patch("/vendors/:id/suspend", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(require2fa), asyncHandler(suspendVendor));
adminRouter.patch("/vendors/:id/unsuspend", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(require2fa), asyncHandler(unsuspendVendor));
adminRouter.get("/vendors/:id/markets", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(listVendorMarkets));
adminRouter.post("/vendors/:id/markets", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(require2fa), asyncHandler(addVendorMarket));
adminRouter.patch("/vendors/:id/markets/:marketCode", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(require2fa), asyncHandler(setVendorMarketEnabled));
// Handbook 14.7 L576: markets are disabled/enabled, never permanently removed (history is kept).
adminRouter.patch("/payout-requests/:id/mark-paid", asyncHandler(requireAdminPermission("payouts.mutate")), asyncHandler(require2fa), asyncHandler(adminMarkPayoutRequestPaid));
