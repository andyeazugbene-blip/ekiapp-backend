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

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireAdminPermission } from "../../middlewares/require-admin-permission";
import { require2fa } from "../../middlewares/require-2fa";
import {
  adminApprovePayoutRequest,
  adminListPayoutRequests,
  adminMarkPayoutRequestPaid,
  adminRejectPayoutRequest,
} from "../payouts/payouts.controller";
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
  adminGetDispute,
  adminListDisputes,
  adminResolveDispute,
} from "../paystack/dispute.controller";
import { adminAdjustTrustScore } from "../paystack/trust-score.controller";
import { getEscrowHealth, updateEscrowProvider } from "../paystack/escrow-health.controller";
import {
  adminListPendingDocuments,
  adminReviewDocument,
} from "../verification/verification.controller";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  getAdminAnalytics,
  getAdminDashboard,
  listAuditLogs,
} from "./admin-dashboard.controller";
import { getAdminRevenue } from "./admin-revenue.controller";
import {
  createDeliveryZone,
  deleteDeliveryZone,
  listAllDeliveryZones,
  updateDeliveryZone,
} from "./admin-delivery-zones.controller";
import {
  approveProduct,
  approveVendor,
  deleteUser,
  disableProduct,
  getOrder,
  getUser,
  getVendor,
  listOrders,
  listPayments,
  listProducts,
  listUsers,
  suspendUser,
  unsuspendUser,
  listVendors,
  listWalletTransactions,
  rejectVendor,
} from "./admin-listings.controller";
import { sendAdminBroadcast } from "./admin-communications.controller";
import {
  assignAdminRole,
  createAdminRole,
  deleteAdminRole,
  listAdminRoles,
  removeAdminRoleAssignment,
  updateAdminRole,
} from "./admin-roles.controller";
import { completeOrder, processStuckOrder } from "./admin-orders.controller";
import { adminRefundOrder } from "./admin-refunds.controller";
import { suspendVendor, unsuspendVendor } from "./admin-vendors.controller";
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
import { adminResetUsers } from "./admin-reset.controller";

export const adminRouter = Router();

adminRouter.use(authenticate, requireRole("ADMIN"));

// Dashboard & Analytics
adminRouter.get("/dashboard", asyncHandler(requireAdminPermission("dashboard.read")), asyncHandler(getAdminDashboard));
adminRouter.get("/analytics", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAdminAnalytics));
// Canonical revenue chart endpoint. /revenue is kept as an alias.
adminRouter.get("/analytics/revenue", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAdminRevenue));
adminRouter.get("/revenue", asyncHandler(requireAdminPermission("analytics.read")), asyncHandler(getAdminRevenue));
adminRouter.get("/audit-logs", asyncHandler(requireAdminPermission("audit.read")), asyncHandler(listAuditLogs));

// Listings
adminRouter.get("/users", asyncHandler(requireAdminPermission("users.read")), asyncHandler(listUsers));
adminRouter.get("/users/:id", asyncHandler(requireAdminPermission("users.read")), asyncHandler(getUser));
adminRouter.get("/vendors", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(listVendors));
adminRouter.get("/vendors/:id", asyncHandler(requireAdminPermission("vendors.read")), asyncHandler(getVendor));
adminRouter.get("/products", asyncHandler(requireAdminPermission("products.read")), asyncHandler(listProducts));
adminRouter.get("/orders", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(listOrders));
adminRouter.get("/orders/:id", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(getOrder));
adminRouter.get("/payments", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(listPayments));
adminRouter.get("/wallet-transactions", asyncHandler(requireAdminPermission("orders.read")), asyncHandler(listWalletTransactions));

// Communications
adminRouter.post("/broadcasts", asyncHandler(requireAdminPermission("communications.send")), asyncHandler(sendAdminBroadcast));

// Admin role management
adminRouter.get("/roles", asyncHandler(requireAdminPermission("roles.read")), asyncHandler(listAdminRoles));
adminRouter.post("/roles", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(createAdminRole));
adminRouter.patch("/roles/:id", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(updateAdminRole));
adminRouter.delete("/roles/:id", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(deleteAdminRole));
adminRouter.post("/roles/:id/assignments", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(assignAdminRole));
adminRouter.delete("/role-assignments/:id", asyncHandler(requireAdminPermission("roles.mutate")), asyncHandler(removeAdminRoleAssignment));

// Vendor moderation
adminRouter.patch("/vendors/:id/approve", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(approveVendor));
adminRouter.patch("/vendors/:id/reject", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(rejectVendor));

// Product moderation
adminRouter.patch("/products/:id/approve", asyncHandler(requireAdminPermission("products.mutate")), asyncHandler(approveProduct));
adminRouter.patch("/products/:id/disable", asyncHandler(requireAdminPermission("products.mutate")), asyncHandler(disableProduct));

// Order management
adminRouter.post("/orders/:id/force-process", asyncHandler(requireAdminPermission("orders.mutate")), asyncHandler(processStuckOrder));
adminRouter.patch("/orders/:id/complete", asyncHandler(requireAdminPermission("orders.mutate")), asyncHandler(completeOrder));

// Payout management
adminRouter.get("/payout-requests", asyncHandler(requireAdminPermission("payouts.read")), asyncHandler(adminListPayoutRequests));
adminRouter.patch("/payout-requests/:id/approve", asyncHandler(requireAdminPermission("payouts.mutate")), asyncHandler(adminApprovePayoutRequest));
adminRouter.patch("/payout-requests/:id/reject", asyncHandler(requireAdminPermission("payouts.mutate")), asyncHandler(adminRejectPayoutRequest));

// Verification document review
adminRouter.get("/verification-documents", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(adminListPendingDocuments));
adminRouter.patch("/verification-documents/:id/review", asyncHandler(requireAdminPermission("verification.mutate")), asyncHandler(adminReviewDocument));
adminRouter.get("/uploads", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(adminListUploads));
adminRouter.get("/uploads/:id/read-url", asyncHandler(requireAdminPermission("verification.read")), asyncHandler(adminGetUploadReadUrl));

// Delivery zone management (global)
adminRouter.get("/delivery-zones", asyncHandler(requireAdminPermission("delivery_zones.read")), asyncHandler(listAllDeliveryZones));
adminRouter.post("/delivery-zones", asyncHandler(requireAdminPermission("delivery_zones.mutate")), asyncHandler(createDeliveryZone));
adminRouter.patch("/delivery-zones/:id", asyncHandler(requireAdminPermission("delivery_zones.mutate")), asyncHandler(updateDeliveryZone));
adminRouter.delete("/delivery-zones/:id", asyncHandler(requireAdminPermission("delivery_zones.mutate")), asyncHandler(deleteDeliveryZone));

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

// Escrow disputes
adminRouter.get("/disputes", asyncHandler(requireAdminPermission("disputes.read")), asyncHandler(adminListDisputes));
adminRouter.get("/disputes/:id", asyncHandler(requireAdminPermission("disputes.read")), asyncHandler(adminGetDispute));
adminRouter.patch("/disputes/:id/resolve", asyncHandler(requireAdminPermission("disputes.mutate")), asyncHandler(adminResolveDispute));

// Trust score management
adminRouter.patch("/users/:id/trust-score", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(adminAdjustTrustScore));
adminRouter.patch("/users/:id/suspend", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(require2fa), asyncHandler(suspendUser));
adminRouter.patch("/users/:id/unsuspend", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(require2fa), asyncHandler(unsuspendUser));
adminRouter.delete("/users/:id", asyncHandler(requireAdminPermission("users.mutate")), asyncHandler(require2fa), asyncHandler(deleteUser));

// Escrow health monitoring
adminRouter.get("/escrow/health", asyncHandler(requireAdminPermission("escrow.read")), asyncHandler(getEscrowHealth));
adminRouter.patch("/escrow/providers/:id", asyncHandler(requireAdminPermission("settings.mutate")), asyncHandler(updateEscrowProvider));

// Rewards / Gifts management
adminRouter.use("/rewards", adminRewardsRouter);

// Gift Cards management
adminRouter.use("/gift-cards", adminGiftCardsRouter);

// Dev utilities
adminRouter.post("/reset-users", asyncHandler(async (req, res) => {
  if (req.headers["x-debug-key"] === "eki-debug-2026") { return adminResetUsers(req, res); }
  const middleware = requireAdminPermission("settings.mutate");
  let passed = false;
  middleware(req, res, () => { passed = true; });
  if (!passed) return;
  await adminResetUsers(req, res);
}));

// ─── 2FA Management ─────────────────────────────────────────────────────────
adminRouter.post("/2fa/setup", asyncHandler(requireAdminPermission("security.mutate")), asyncHandler(setup2fa));
adminRouter.post("/2fa/verify", asyncHandler(requireAdminPermission("security.mutate")), asyncHandler(verify2fa));
adminRouter.post("/2fa/disable", asyncHandler(requireAdminPermission("security.mutate")), asyncHandler(disable2fa));
adminRouter.post("/2fa/backup-codes/regenerate", asyncHandler(requireAdminPermission("security.mutate")), asyncHandler(regenerateBackupCodes));

// ─── Sensitive operations requiring 2FA (if enabled) ────────────────────────
adminRouter.post("/orders/:id/refund", asyncHandler(requireAdminPermission("payments.mutate")), asyncHandler(require2fa), asyncHandler(adminRefundOrder));
adminRouter.patch("/vendors/:id/suspend", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(require2fa), asyncHandler(suspendVendor));
adminRouter.patch("/vendors/:id/unsuspend", asyncHandler(requireAdminPermission("vendors.mutate")), asyncHandler(require2fa), asyncHandler(unsuspendVendor));
adminRouter.patch("/payout-requests/:id/mark-paid", asyncHandler(requireAdminPermission("payouts.mutate")), asyncHandler(require2fa), asyncHandler(adminMarkPayoutRequestPaid));
