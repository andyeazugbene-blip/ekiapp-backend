import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import { requireVendorProfile } from "../../middlewares/require-capability";
import { requireAdminPermission } from "../../middlewares/require-admin-permission";
import { require2fa } from "../../middlewares/require-2fa";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  adminCancelInvalidPriceChange,
  adminChangeSubscriptionFrequency,
  adminContactBuyerFromRenewal,
  adminContactBuyerFromSubscription,
  adminEscalateRenewal,
  adminForceCancelSubscription,
  adminGetSubscription,
  adminListSubscriptionExceptions,
  adminListSubscriptions,
  adminPauseSubscription,
  adminResumeSubscription,
  adminSetNextDate,
  adminSkipNextSubscription,
  adminSubscriptionReports,
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
  rescheduleNextBuyerSubscription,
  retryRenewalPayment,
  skipNextRenewal,
  updateBuyerSubscriptionPaymentMethod,
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
subscriptionOffersRouter.patch("/:id", authenticate, requireVendorProfile(), asyncHandler(updateSubscriptionOffer));
subscriptionOffersRouter.post("/:id/publish", authenticate, requireVendorProfile(), asyncHandler(publishSubscriptionOffer));
subscriptionOffersRouter.post("/:id/unpublish", authenticate, requireVendorProfile(), asyncHandler(unpublishSubscriptionOffer));
subscriptionOffersRouter.post("/:id/pause-renewals", authenticate, requireVendorProfile(), asyncHandler(pauseSubscriptionOfferRenewals));
subscriptionOffersRouter.post("/:id/resume-renewals", authenticate, requireVendorProfile(), asyncHandler(resumeSubscriptionOfferRenewals));
subscriptionOffersRouter.post("/:id/products/:productId/pause", authenticate, requireVendorProfile(), asyncHandler(pauseSubscriptionOfferProduct));
subscriptionOffersRouter.post("/:id/products/:productId/resume", authenticate, requireVendorProfile(), asyncHandler(resumeSubscriptionOfferProduct));

// Vendor-owned resources — mounted at /vendor alongside the other vendor
// routers (automation, account, etc.), consistent with this codebase's
// convention of deriving the vendor from the authenticated user rather
// than taking a vendorId path param.
export const regularDeliveriesVendorRouter = Router();
regularDeliveriesVendorRouter.use(authenticate, requireVendorProfile());
regularDeliveriesVendorRouter.post("/subscription-offers", asyncHandler(createSubscriptionOffer));
regularDeliveriesVendorRouter.get("/subscription-offers", asyncHandler(listVendorSubscriptionOffers));
regularDeliveriesVendorRouter.get("/subscribers", asyncHandler(listVendorSubscribers));
regularDeliveriesVendorRouter.get("/subscribers/:id", asyncHandler(getVendorSubscriberDetail));
regularDeliveriesVendorRouter.get("/renewals", asyncHandler(listVendorRenewals));
regularDeliveriesVendorRouter.get("/insights", asyncHandler(getVendorRegularDeliveryInsights));

// Renewal actions (vendor stock confirmation, buyer decisions) — mounted
// at /renewals. Per-route auth since the action taken determines the role.
export const renewalsRouter = Router();
renewalsRouter.post("/:id/stock-confirmation", authenticate, requireVendorProfile(), asyncHandler(confirmRenewalStock));
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
// Handbook section 9: choose a new date for the next delivery + switch card for payment recovery.
buyerSubscriptionsRouter.post("/:id/reschedule-next", asyncHandler(rescheduleNextBuyerSubscription));
buyerSubscriptionsRouter.post("/:id/payment-method", asyncHandler(updateBuyerSubscriptionPaymentMethod));

// Admin: Foodstuffs Subscription module - mounted at /admin/subscriptions and
// /admin/renewals. Reads need subscriptions.read; every mutation needs
// subscriptions.mutate + 2FA (when enabled) + a required reason (validated
// server-side in subscription-admin.service.ts) + an AuditLog row.
// Static paths (exceptions, reports) are registered before "/:id".
const read = asyncHandler(requireAdminPermission("subscriptions.read"));
const mutate = asyncHandler(requireAdminPermission("subscriptions.mutate"));
const twoFa = asyncHandler(require2fa);

export const adminSubscriptionsRouter = Router();
adminSubscriptionsRouter.use(authenticate, requireRole("ADMIN"));
adminSubscriptionsRouter.get("/", read, asyncHandler(adminListSubscriptions));
adminSubscriptionsRouter.get("/exceptions", read, asyncHandler(adminListSubscriptionExceptions));
adminSubscriptionsRouter.get("/reports", read, asyncHandler(adminSubscriptionReports));
adminSubscriptionsRouter.get("/:id", read, asyncHandler(adminGetSubscription));
// Retry payment: :id is a renewal id (exceptions queue) or a subscription id (detail page).
adminSubscriptionsRouter.post("/:id/retry-payment", mutate, twoFa, asyncHandler(adminRetryRenewalPayment));
adminSubscriptionsRouter.post("/:id/pause", mutate, twoFa, asyncHandler(adminPauseSubscription));
adminSubscriptionsRouter.post("/:id/resume", mutate, twoFa, asyncHandler(adminResumeSubscription));
adminSubscriptionsRouter.post("/:id/skip-next", mutate, twoFa, asyncHandler(adminSkipNextSubscription));
adminSubscriptionsRouter.post("/:id/set-next-date", mutate, twoFa, asyncHandler(adminSetNextDate));
adminSubscriptionsRouter.post("/:id/force-cancel", mutate, twoFa, asyncHandler(adminForceCancelSubscription));
adminSubscriptionsRouter.post("/:id/change-frequency", mutate, twoFa, asyncHandler(adminChangeSubscriptionFrequency));
adminSubscriptionsRouter.post("/:id/contact-buyer", mutate, asyncHandler(adminContactBuyerFromSubscription));

export const adminRenewalsRouter = Router();
adminRenewalsRouter.use(authenticate, requireRole("ADMIN"));
adminRenewalsRouter.post("/:id/contact-buyer", mutate, asyncHandler(adminContactBuyerFromRenewal));
adminRenewalsRouter.post("/:id/resend-price-change", mutate, asyncHandler(adminResendPriceChangeNotification));
adminRenewalsRouter.post("/:id/cancel-price-change", mutate, twoFa, asyncHandler(adminCancelInvalidPriceChange));
adminRenewalsRouter.post("/:id/admin-skip", mutate, twoFa, asyncHandler(adminSkipRenewal));
// Escalation is an internal flag, not a financial mutation: no 2FA.
adminRenewalsRouter.post("/:id/escalate", mutate, asyncHandler(adminEscalateRenewal));
