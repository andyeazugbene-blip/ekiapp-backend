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
import { getEscrowHealth } from "../paystack/escrow-health.controller";
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
  disableProduct,
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
import { completeOrder } from "./admin-orders.controller";
import { adminRefundOrder } from "./admin-refunds.controller";
import { suspendVendor, unsuspendVendor } from "./admin-vendors.controller";
import {
  disable2fa,
  regenerateBackupCodes,
  setup2fa,
  verify2fa,
} from "./admin-2fa.controller";
import {
  listAdminPlans,
  upsertAdminPlan,
} from "../subscriptions/subscriptions.controller";

export const adminRouter = Router();

adminRouter.use(authenticate, requireRole("ADMIN"));

// Dashboard & Analytics
adminRouter.get("/dashboard", asyncHandler(getAdminDashboard));
adminRouter.get("/analytics", asyncHandler(getAdminAnalytics));
// Canonical revenue chart endpoint. /revenue is kept as an alias.
adminRouter.get("/analytics/revenue", asyncHandler(getAdminRevenue));
adminRouter.get("/revenue", asyncHandler(getAdminRevenue));
adminRouter.get("/audit-logs", asyncHandler(listAuditLogs));

// Listings
adminRouter.get("/users", asyncHandler(listUsers));
adminRouter.get("/vendors", asyncHandler(listVendors));
adminRouter.get("/products", asyncHandler(listProducts));
adminRouter.get("/orders", asyncHandler(listOrders));
adminRouter.get("/payments", asyncHandler(listPayments));
adminRouter.get("/wallet-transactions", asyncHandler(listWalletTransactions));

// Vendor moderation
adminRouter.patch("/vendors/:id/approve", asyncHandler(approveVendor));
adminRouter.patch("/vendors/:id/reject", asyncHandler(rejectVendor));

// Product moderation
adminRouter.patch("/products/:id/approve", asyncHandler(approveProduct));
adminRouter.patch("/products/:id/disable", asyncHandler(disableProduct));

// Order management
adminRouter.patch("/orders/:id/complete", asyncHandler(completeOrder));

// Payout management
adminRouter.get("/payout-requests", asyncHandler(adminListPayoutRequests));
adminRouter.patch("/payout-requests/:id/approve", asyncHandler(adminApprovePayoutRequest));
adminRouter.patch("/payout-requests/:id/reject", asyncHandler(adminRejectPayoutRequest));

// Verification document review
adminRouter.get("/verification-documents", asyncHandler(adminListPendingDocuments));
adminRouter.patch("/verification-documents/:id/review", asyncHandler(adminReviewDocument));

// Delivery zone management (global)
adminRouter.get("/delivery-zones", asyncHandler(listAllDeliveryZones));
adminRouter.post("/delivery-zones", asyncHandler(createDeliveryZone));
adminRouter.patch("/delivery-zones/:id", asyncHandler(updateDeliveryZone));
adminRouter.delete("/delivery-zones/:id", asyncHandler(deleteDeliveryZone));

// Promo code management
adminRouter.get("/promo-codes", asyncHandler(adminListPromoCodes));
adminRouter.post("/promo-codes", asyncHandler(adminCreatePromoCode));
adminRouter.patch("/promo-codes/:id", asyncHandler(adminUpdatePromoCode));

// Subscription plan management
adminRouter.get("/subscription-plans", asyncHandler(listAdminPlans));
adminRouter.post("/subscription-plans", asyncHandler(upsertAdminPlan));
adminRouter.patch("/subscription-plans/:plan", asyncHandler(upsertAdminPlan));

// Review moderation
adminRouter.get("/reviews", asyncHandler(adminListReviews));
adminRouter.patch("/reviews/:id/moderate", asyncHandler(adminModerateReview));

// Escrow disputes
adminRouter.get("/disputes", asyncHandler(adminListDisputes));
adminRouter.get("/disputes/:id", asyncHandler(adminGetDispute));
adminRouter.patch("/disputes/:id/resolve", asyncHandler(adminResolveDispute));

// Trust score management
adminRouter.patch("/users/:id/trust-score", asyncHandler(adminAdjustTrustScore));
adminRouter.patch("/users/:id/suspend", asyncHandler(require2fa), asyncHandler(suspendUser));
adminRouter.patch("/users/:id/unsuspend", asyncHandler(require2fa), asyncHandler(unsuspendUser));

// Escrow health monitoring
adminRouter.get("/escrow/health", asyncHandler(getEscrowHealth));

// ─── 2FA Management ─────────────────────────────────────────────────────────
adminRouter.post("/2fa/setup", asyncHandler(setup2fa));
adminRouter.post("/2fa/verify", asyncHandler(verify2fa));
adminRouter.post("/2fa/disable", asyncHandler(disable2fa));
adminRouter.post("/2fa/backup-codes/regenerate", asyncHandler(regenerateBackupCodes));

// ─── Sensitive operations requiring 2FA (if enabled) ────────────────────────
adminRouter.post("/orders/:id/refund", asyncHandler(require2fa), asyncHandler(adminRefundOrder));
adminRouter.patch("/vendors/:id/suspend", asyncHandler(require2fa), asyncHandler(suspendVendor));
adminRouter.patch("/vendors/:id/unsuspend", asyncHandler(require2fa), asyncHandler(unsuspendVendor));
adminRouter.patch("/payout-requests/:id/mark-paid", asyncHandler(require2fa), asyncHandler(adminMarkPayoutRequestPaid));
