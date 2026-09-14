import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { requireVendorProfileOrAdmin } from "../../middlewares/require-capability";
import { requireSellerPlanFeature } from "../../middlewares/require-seller-plan-feature";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  getVendorOrder,
  listVendorOrders,
  updateVendorOrderStatus,
} from "../orders/orders.controller";
import {
  createStripeVerificationSession,
  getOwnVerification,
  getStripeVerificationStatus,
  resetVerification,
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
import {
  addOwnVendorMarket,
  listOwnVendorMarkets,
  removeOwnVendorMarket,
  setOwnVendorMarketEnabled,
} from "./vendor-markets.controller";
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
vendorsRouter.get("/me", requireVendorProfileOrAdmin(), asyncHandler(getOwnVendor));
vendorsRouter.patch("/me", requireVendorProfileOrAdmin(), asyncHandler(updateOwnVendor));
vendorsRouter.get("/me/dashboard", requireVendorProfileOrAdmin(), asyncHandler(getVendorDashboard));
vendorsRouter.get("/me/markets", requireVendorProfileOrAdmin(), asyncHandler(listOwnVendorMarkets));
vendorsRouter.post("/me/markets", requireVendorProfileOrAdmin(), asyncHandler(addOwnVendorMarket));
vendorsRouter.patch("/me/markets/:marketCode", requireVendorProfileOrAdmin(), asyncHandler(setOwnVendorMarketEnabled));
vendorsRouter.delete("/me/markets/:marketCode", requireVendorProfileOrAdmin(), asyncHandler(removeOwnVendorMarket));
vendorsRouter.get("/me/earnings", requireVendorProfileOrAdmin(), asyncHandler(getVendorEarnings));
vendorsRouter.get(
  "/me/analytics",
  requireVendorProfileOrAdmin(),
  asyncHandler(requireSellerPlanFeature("analytics")),
  asyncHandler(getVendorAnalytics),
);
// Revenue chart for the mobile vendor dashboard.
// Canonical path is /me/analytics/revenue. /me/revenue is kept as an alias
// for the previous round of frontend code that already shipped that path.
vendorsRouter.get(
  "/me/analytics/revenue",
  requireVendorProfileOrAdmin(),
  asyncHandler(requireSellerPlanFeature("analytics")),
  asyncHandler(getVendorRevenue),
);
vendorsRouter.get(
  "/me/revenue",
  requireVendorProfileOrAdmin(),
  asyncHandler(requireSellerPlanFeature("analytics")),
  asyncHandler(getVendorRevenue),
);
vendorsRouter.get("/me/public-store-analytics", requireVendorProfileOrAdmin(), asyncHandler(getVendorPublicStoreAnalytics));
vendorsRouter.get("/me/buyers", requireVendorProfileOrAdmin(), asyncHandler(listVendorBuyers));
vendorsRouter.get("/me/buyers/:id", requireVendorProfileOrAdmin(), asyncHandler(getVendorBuyer));
vendorsRouter.post("/me/payout-methods", requireVendorProfileOrAdmin(), asyncHandler(createPayoutMethod));
vendorsRouter.get("/me/payout-methods", requireVendorProfileOrAdmin(), asyncHandler(listPayoutMethods));
vendorsRouter.patch("/me/payout-methods/:id", requireVendorProfileOrAdmin(), asyncHandler(updatePayoutMethod));
vendorsRouter.delete("/me/payout-methods/:id", requireVendorProfileOrAdmin(), asyncHandler(deletePayoutMethod));
vendorsRouter.patch("/me/payout-methods/:id/default", requireVendorProfileOrAdmin(), asyncHandler(setDefaultPayoutMethod));

// Stripe Connect
vendorsRouter.post("/me/stripe-connect/onboard", requireVendorProfileOrAdmin(), asyncHandler(onboardStripeConnect));
vendorsRouter.get("/me/stripe-connect/status", requireVendorProfileOrAdmin(), asyncHandler(getStripeConnectStatus));
vendorsRouter.post("/me/stripe-connect/refresh", requireVendorProfileOrAdmin(), asyncHandler(refreshStripeConnect));

// Vendor verification (KYC)
vendorsRouter.post("/me/verification", requireVendorProfileOrAdmin(), asyncHandler(submitVerificationDocument));
vendorsRouter.get("/me/verification", requireVendorProfileOrAdmin(), asyncHandler(getOwnVerification));
vendorsRouter.delete("/me/verification", requireVendorProfileOrAdmin(), asyncHandler(resetVerification));

// Stripe Identity verification
vendorsRouter.post("/me/verification/stripe-session", requireVendorProfileOrAdmin(), asyncHandler(createStripeVerificationSession));
vendorsRouter.get("/me/verification/stripe-status", requireVendorProfileOrAdmin(), asyncHandler(getStripeVerificationStatus));

// Vendor order management
vendorsRouter.get("/me/orders", requireVendorProfileOrAdmin(), asyncHandler(listVendorOrders));
vendorsRouter.get("/me/orders/:id", requireVendorProfileOrAdmin(), asyncHandler(getVendorOrder));
vendorsRouter.patch("/me/orders/:id/status", requireVendorProfileOrAdmin(), asyncHandler(updateVendorOrderStatus));
vendorsRouter.post("/me/orders/:id/confirm-escrow", requireVendorProfileOrAdmin(), asyncHandler(vendorConfirmEscrowOrder));
vendorsRouter.post("/me/orders/:id/dispatch", requireVendorProfileOrAdmin(), asyncHandler(vendorDispatchOrder));
vendorsRouter.post("/me/bank-accounts", requireVendorProfileOrAdmin(), asyncHandler(registerBankAccount));
vendorsRouter.get("/me/bank-accounts", requireVendorProfileOrAdmin(), asyncHandler(listBankAccounts));
