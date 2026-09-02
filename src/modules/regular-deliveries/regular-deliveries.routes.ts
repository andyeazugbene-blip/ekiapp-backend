import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  cancelBuyerSubscription,
  confirmRenewalStock,
  confirmSetupIntent,
  createBuyerSubscription,
  createSetupIntent,
  createSubscriptionOffer,
  decideRenewalPriceChange,
  getBuyerSubscription,
  getPublicSubscriptionOffer,
  getVendorRegularDeliveryInsights,
  getVendorSubscriberDetail,
  listBuyerSubscriptions,
  listPaymentMethods,
  listVendorRenewals,
  listVendorSubscribers,
  listVendorSubscriptionOffers,
  pauseBuyerSubscription,
  pauseSubscriptionOfferRenewals,
  publishSubscriptionOffer,
  removePaymentMethod,
  resumeBuyerSubscription,
  resumeSubscriptionOfferRenewals,
  retryRenewalPayment,
  skipNextRenewal,
  unpublishSubscriptionOffer,
  updateBuyerSubscription,
  updateSubscriptionOffer,
} from "./regular-deliveries.controller";

// Mounted at its own /subscription-offers prefix — public read, per-route
// vendor auth for mutations (same pattern as products.routes.ts), never a
// blanket router-level `.use(authenticate)` with no path, which would
// swallow every request reaching this router regardless of which route
// actually matches.
export const subscriptionOffersRouter = Router();
subscriptionOffersRouter.get("/:id", asyncHandler(getPublicSubscriptionOffer));
subscriptionOffersRouter.patch("/:id", authenticate, requireRole("VENDOR"), asyncHandler(updateSubscriptionOffer));
subscriptionOffersRouter.post("/:id/publish", authenticate, requireRole("VENDOR"), asyncHandler(publishSubscriptionOffer));
subscriptionOffersRouter.post("/:id/unpublish", authenticate, requireRole("VENDOR"), asyncHandler(unpublishSubscriptionOffer));
subscriptionOffersRouter.post("/:id/pause-renewals", authenticate, requireRole("VENDOR"), asyncHandler(pauseSubscriptionOfferRenewals));
subscriptionOffersRouter.post("/:id/resume-renewals", authenticate, requireRole("VENDOR"), asyncHandler(resumeSubscriptionOfferRenewals));

// Vendor-owned resources — mounted at /vendor alongside the other vendor
// routers (automation, account, etc.), consistent with this codebase's
// convention of deriving the vendor from the authenticated user rather
// than taking a vendorId path param.
export const regularDeliveriesVendorRouter = Router();
regularDeliveriesVendorRouter.use(authenticate, requireRole("VENDOR"));
regularDeliveriesVendorRouter.post("/subscription-offers", asyncHandler(createSubscriptionOffer));
regularDeliveriesVendorRouter.get("/subscription-offers", asyncHandler(listVendorSubscriptionOffers));
regularDeliveriesVendorRouter.get("/subscribers", asyncHandler(listVendorSubscribers));
regularDeliveriesVendorRouter.get("/subscribers/:id", asyncHandler(getVendorSubscriberDetail));
regularDeliveriesVendorRouter.get("/renewals", asyncHandler(listVendorRenewals));
regularDeliveriesVendorRouter.get("/insights", asyncHandler(getVendorRegularDeliveryInsights));

// Renewal actions (vendor stock confirmation, buyer decisions) — mounted
// at /renewals. Per-route auth since the action taken determines the role.
export const renewalsRouter = Router();
renewalsRouter.post("/:id/stock-confirmation", authenticate, requireRole("VENDOR"), asyncHandler(confirmRenewalStock));
renewalsRouter.post("/:id/price-change", authenticate, asyncHandler(decideRenewalPriceChange));
renewalsRouter.post("/:id/retry-payment", authenticate, asyncHandler(retryRenewalPayment));

// Buyer: saved payment methods — mounted at /buyer/payment-methods.
export const buyerPaymentMethodsRouter = Router();
buyerPaymentMethodsRouter.use(authenticate);
buyerPaymentMethodsRouter.post("/setup-intent", asyncHandler(createSetupIntent));
buyerPaymentMethodsRouter.post("/", asyncHandler(confirmSetupIntent));
buyerPaymentMethodsRouter.get("/", asyncHandler(listPaymentMethods));
buyerPaymentMethodsRouter.delete("/:id", asyncHandler(removePaymentMethod));

// Buyer: subscriptions — mounted at /buyer/subscriptions.
export const buyerSubscriptionsRouter = Router();
buyerSubscriptionsRouter.use(authenticate);
buyerSubscriptionsRouter.post("/", asyncHandler(createBuyerSubscription));
buyerSubscriptionsRouter.get("/", asyncHandler(listBuyerSubscriptions));
buyerSubscriptionsRouter.get("/:id", asyncHandler(getBuyerSubscription));
buyerSubscriptionsRouter.patch("/:id", asyncHandler(updateBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/pause", asyncHandler(pauseBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/resume", asyncHandler(resumeBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/cancel", asyncHandler(cancelBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/skip-next", asyncHandler(skipNextRenewal));
