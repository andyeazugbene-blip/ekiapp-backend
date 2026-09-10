import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  adminCancelInvalidPriceChange,
  adminChangeSubscriptionFrequency,
  adminContactBuyerFromRenewal,
  adminContactBuyerFromSubscription,
  adminForceCancelSubscription,
  adminListSubscriptionExceptions,
  adminResendPriceChangeNotification,
  adminRetryRenewalPayment,
  adminSkipRenewal,
  cancelBuyerSubscription,
  changeBuyerSubscriptionFrequency,
  confirmRenewalStock,
  confirmSetupIntent,
  createBuyerSubscription,
  createSetupIntent,
  createSubscriptionOffer,
  decideRenewalPriceChange,
  getBuyerSubscription,
  getPublicSubscriptionOffer,
  getReorderSuggestions,
  getVendorRegularDeliveryInsights,
  getVendorSubscriberDetail,
  listBuyerSubscriptions,
  listPaymentMethods,
  listPublicSubscriptionOffers,
  listVendorRenewals,
  listVendorSubscribers,
  listVendorSubscriptionOffers,
  pauseBuyerSubscription,
  pauseSubscriptionOfferProduct,
  pauseSubscriptionOfferRenewals,
  publishSubscriptionOffer,
  removePaymentMethod,
  resumeBuyerSubscription,
  resumeSubscriptionOfferProduct,
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
// Must be registered BEFORE "/:id" — otherwise Express would match
// "/public" as an :id param and this route would never be reached.
subscriptionOffersRouter.get("/public", asyncHandler(listPublicSubscriptionOffers));
subscriptionOffersRouter.get("/:id", asyncHandler(getPublicSubscriptionOffer));
subscriptionOffersRouter.patch("/:id", authenticate, requireRole("VENDOR"), asyncHandler(updateSubscriptionOffer));
subscriptionOffersRouter.post("/:id/publish", authenticate, requireRole("VENDOR"), asyncHandler(publishSubscriptionOffer));
subscriptionOffersRouter.post("/:id/unpublish", authenticate, requireRole("VENDOR"), asyncHandler(unpublishSubscriptionOffer));
subscriptionOffersRouter.post("/:id/pause-renewals", authenticate, requireRole("VENDOR"), asyncHandler(pauseSubscriptionOfferRenewals));
subscriptionOffersRouter.post("/:id/resume-renewals", authenticate, requireRole("VENDOR"), asyncHandler(resumeSubscriptionOfferRenewals));
subscriptionOffersRouter.post("/:id/products/:productId/pause", authenticate, requireRole("VENDOR"), asyncHandler(pauseSubscriptionOfferProduct));
subscriptionOffersRouter.post("/:id/products/:productId/resume", authenticate, requireRole("VENDOR"), asyncHandler(resumeSubscriptionOfferProduct));

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
// Must come before /:id — otherwise "reorder-suggestions" is swallowed as an :id value.
buyerSubscriptionsRouter.get("/reorder-suggestions", asyncHandler(getReorderSuggestions));
buyerSubscriptionsRouter.get("/:id", asyncHandler(getBuyerSubscription));
buyerSubscriptionsRouter.patch("/:id", asyncHandler(updateBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/pause", asyncHandler(pauseBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/resume", asyncHandler(resumeBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/cancel", asyncHandler(cancelBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/skip-next", asyncHandler(skipNextRenewal));
// Final Client Decision 3: buyer frequency editing.
buyerSubscriptionsRouter.post("/:id/change-frequency", asyncHandler(changeBuyerSubscriptionFrequency));

// Admin: Regular Delivery monitoring and intervention — mounted at /admin/subscriptions
// and /admin/renewals (inside the single main admin app).
// Final Client Decisions 2 + 3.
export const adminSubscriptionsRouter = Router();
adminSubscriptionsRouter.use(authenticate, requireRole("ADMIN"));
adminSubscriptionsRouter.get("/exceptions", asyncHandler(adminListSubscriptionExceptions));
// Retry payment (RD-08, existing)
adminSubscriptionsRouter.post("/:id/retry-payment", asyncHandler(adminRetryRenewalPayment));
// Forced cancellation (Decision 2 — exceptional support action)
adminSubscriptionsRouter.post("/:id/force-cancel", asyncHandler(adminForceCancelSubscription));
// Contact buyer from subscription context (Decision 2)
adminSubscriptionsRouter.post("/:id/contact-buyer", asyncHandler(adminContactBuyerFromSubscription));
// Admin frequency correction (Decision 3 — support action only)
adminSubscriptionsRouter.post("/:id/change-frequency", asyncHandler(adminChangeSubscriptionFrequency));

export const adminRenewalsRouter = Router();
adminRenewalsRouter.use(authenticate, requireRole("ADMIN"));
// Contact buyer from renewal context (Decision 2)
adminRenewalsRouter.post("/:id/contact-buyer", asyncHandler(adminContactBuyerFromRenewal));
// Resend price-change notification (Decision 2)
adminRenewalsRouter.post("/:id/resend-price-change", asyncHandler(adminResendPriceChangeNotification));
// Cancel invalid price-change request (Decision 2)
adminRenewalsRouter.delete("/:id/price-change", asyncHandler(adminCancelInvalidPriceChange));
// Admin skip renewal (Decision 2)
adminRenewalsRouter.post("/:id/admin-skip", asyncHandler(adminSkipRenewal));

