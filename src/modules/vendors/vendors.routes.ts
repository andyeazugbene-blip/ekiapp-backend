import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireSellerPlanFeature } from "../../middlewares/require-seller-plan-feature";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  getVendorOrder,
  listVendorOrders,
  updateVendorOrderStatus,
} from "../orders/orders.controller";
import {
  getOwnVerification,
  submitVerificationDocument,
} from "../verification/verification.controller";
import {
  createPayoutMethod,
  createVendor,
  getPublicVendor,
  getOwnVendor,
  listPublicVendors,
  listPayoutMethods,
  updateOwnVendor,
  updatePayoutMethod,
  deletePayoutMethod,
  setDefaultPayoutMethod,
} from "./vendors.controller";
import {
  getVendorDashboard,
  getVendorEarnings,
} from "./vendors-dashboard.controller";
import { getVendorAnalytics } from "./vendors-analytics.controller";
import { getVendorRevenue } from "./vendors-revenue.controller";
import {
  getVendorBuyer,
  listVendorBuyers,
} from "./vendors-buyers.controller";
import { vendorConfirmEscrowOrder, vendorDispatchOrder, registerBankAccount, listBankAccounts } from "../paystack/escrow.controller";
import { getVendorPublicStoreAnalytics } from "../public-stores/public-stores.controller";
import {
  getStripeConnectStatus,
  onboardStripeConnect,
  refreshStripeConnect,
} from "./stripe-connect.controller";

export const vendorsRouter = Router();

vendorsRouter.get("/", asyncHandler(listPublicVendors));
vendorsRouter.get("/:id([A-Za-z0-9]{10,})", asyncHandler(getPublicVendor));

vendorsRouter.use(authenticate);

// Any authenticated user can create a vendor profile (promotion endpoint)
vendorsRouter.post("/", asyncHandler(createVendor));

// All routes below require VENDOR role
vendorsRouter.get("/me", requireRole("VENDOR", "ADMIN"), asyncHandler(getOwnVendor));
vendorsRouter.patch("/me", requireRole("VENDOR", "ADMIN"), asyncHandler(updateOwnVendor));
vendorsRouter.get("/me/dashboard", requireRole("VENDOR", "ADMIN"), asyncHandler(getVendorDashboard));
vendorsRouter.get("/me/earnings", requireRole("VENDOR", "ADMIN"), asyncHandler(getVendorEarnings));
vendorsRouter.get(
  "/me/analytics",
  requireRole("VENDOR", "ADMIN"),
  asyncHandler(requireSellerPlanFeature("analytics")),
  asyncHandler(getVendorAnalytics),
);
// Revenue chart for the mobile vendor dashboard.
// Canonical path is /me/analytics/revenue. /me/revenue is kept as an alias
// for the previous round of frontend code that already shipped that path.
vendorsRouter.get(
  "/me/analytics/revenue",
  requireRole("VENDOR", "ADMIN"),
  asyncHandler(requireSellerPlanFeature("analytics")),
  asyncHandler(getVendorRevenue),
);
vendorsRouter.get(
  "/me/revenue",
  requireRole("VENDOR", "ADMIN"),
  asyncHandler(requireSellerPlanFeature("analytics")),
  asyncHandler(getVendorRevenue),
);
vendorsRouter.get("/me/public-store-analytics", requireRole("VENDOR", "ADMIN"), asyncHandler(getVendorPublicStoreAnalytics));
vendorsRouter.get("/me/buyers", requireRole("VENDOR", "ADMIN"), asyncHandler(listVendorBuyers));
vendorsRouter.get("/me/buyers/:id", requireRole("VENDOR", "ADMIN"), asyncHandler(getVendorBuyer));
vendorsRouter.post("/me/payout-methods", requireRole("VENDOR", "ADMIN"), asyncHandler(createPayoutMethod));
vendorsRouter.get("/me/payout-methods", requireRole("VENDOR", "ADMIN"), asyncHandler(listPayoutMethods));
vendorsRouter.patch("/me/payout-methods/:id", requireRole("VENDOR", "ADMIN"), asyncHandler(updatePayoutMethod));
vendorsRouter.delete("/me/payout-methods/:id", requireRole("VENDOR", "ADMIN"), asyncHandler(deletePayoutMethod));
vendorsRouter.patch("/me/payout-methods/:id/default", requireRole("VENDOR", "ADMIN"), asyncHandler(setDefaultPayoutMethod));

// Stripe Connect
vendorsRouter.post("/me/stripe-connect/onboard", requireRole("VENDOR", "ADMIN"), asyncHandler(onboardStripeConnect));
vendorsRouter.get("/me/stripe-connect/status", requireRole("VENDOR", "ADMIN"), asyncHandler(getStripeConnectStatus));
vendorsRouter.post("/me/stripe-connect/refresh", requireRole("VENDOR", "ADMIN"), asyncHandler(refreshStripeConnect));

// Vendor verification (KYC)
vendorsRouter.post("/me/verification", requireRole("VENDOR", "ADMIN"), asyncHandler(submitVerificationDocument));
vendorsRouter.get("/me/verification", requireRole("VENDOR", "ADMIN"), asyncHandler(getOwnVerification));

// Vendor order management
vendorsRouter.get("/me/orders", requireRole("VENDOR", "ADMIN"), asyncHandler(listVendorOrders));
vendorsRouter.get("/me/orders/:id", requireRole("VENDOR", "ADMIN"), asyncHandler(getVendorOrder));
vendorsRouter.patch("/me/orders/:id/status", requireRole("VENDOR", "ADMIN"), asyncHandler(updateVendorOrderStatus));
vendorsRouter.post("/me/orders/:id/confirm-escrow", requireRole("VENDOR", "ADMIN"), asyncHandler(vendorConfirmEscrowOrder));
vendorsRouter.post("/me/orders/:id/dispatch", requireRole("VENDOR", "ADMIN"), asyncHandler(vendorDispatchOrder));
vendorsRouter.post("/me/bank-accounts", requireRole("VENDOR", "ADMIN"), asyncHandler(registerBankAccount));
vendorsRouter.get("/me/bank-accounts", requireRole("VENDOR", "ADMIN"), asyncHandler(listBankAccounts));
