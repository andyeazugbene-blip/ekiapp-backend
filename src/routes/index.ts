import { Router } from "express";
import swaggerUi from "swagger-ui-express";

import { swaggerSpec } from "../lib/swagger";
import { addressesRouter } from "../modules/addresses/addresses.routes";
import { adminRouter } from "../modules/admin/admin.routes";
import { authRouter } from "../modules/auth/auth.routes";
import { buyerWalletRouter } from "../modules/buyer-wallet/buyer-wallet.routes";
import { cartRouter } from "../modules/cart/cart.routes";
import { deliveryRouter } from "../modules/delivery/delivery.routes";
import { healthRouter } from "../modules/health/health.routes";
import { messagesRouter } from "../modules/messages/messages.routes";
import { notificationsRouter } from "../modules/notifications/notifications.routes";
import { ordersRouter } from "../modules/orders/orders.routes";
import { paymentsRouter } from "../modules/payments/payments.routes";
import { payoutRequestsRouter } from "../modules/payouts/payouts.routes";
import { productsRouter } from "../modules/products/products.routes";
import { promosRouter } from "../modules/promos/promos.routes";
import { pushTokensRouter } from "../modules/push-tokens/push-tokens.routes";
import { referralsRouter } from "../modules/referrals/referrals.routes";
import { shipmentsRouter } from "../modules/shipments/shipments.routes";
import { stripeRouter } from "../modules/stripe/stripe.routes";
import { subscriptionsRouter } from "../modules/subscriptions/subscriptions.routes";
import { uploadsRouter } from "../modules/uploads/uploads.routes";
import { vendorsRouter } from "../modules/vendors/vendors.routes";

export const apiRouter = Router();

// Swagger UI — only in non-production environments
if (process.env.NODE_ENV !== "production") {
  apiRouter.get("/docs.json", (_req, res) => {
    res.json(swaggerSpec);
  });
  apiRouter.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: "Italian Marketplace API",
    }),
  );
}

apiRouter.use(healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/vendors", vendorsRouter);
apiRouter.use("/products", productsRouter);
apiRouter.use("/cart", cartRouter);
apiRouter.use("/delivery", deliveryRouter);
apiRouter.use("/orders", ordersRouter);
apiRouter.use("/payments", paymentsRouter);
apiRouter.use("/payout-requests", payoutRequestsRouter);
apiRouter.use("/notifications", notificationsRouter);
apiRouter.use("/conversations", messagesRouter);
apiRouter.use("/addresses", addressesRouter);
apiRouter.use("/uploads", uploadsRouter);
apiRouter.use("/shipments", shipmentsRouter);
apiRouter.use("/wallet", buyerWalletRouter);
apiRouter.use("/promo-codes", promosRouter);
apiRouter.use("/referrals", referralsRouter);
apiRouter.use("/subscriptions", subscriptionsRouter);
apiRouter.use("/push-tokens", pushTokensRouter);
apiRouter.use("/stripe", stripeRouter);
