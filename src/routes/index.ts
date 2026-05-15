import { Router } from "express";

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
import { publicStoresRouter } from "../modules/public-stores/public-stores.routes";
import { pushTokensRouter } from "../modules/push-tokens/push-tokens.routes";
import { referralsRouter } from "../modules/referrals/referrals.routes";
import { reviewsRouter } from "../modules/reviews/reviews.routes";
import { shipmentsRouter } from "../modules/shipments/shipments.routes";
import { stripeRouter } from "../modules/stripe/stripe.routes";
import { subscriptionsRouter } from "../modules/subscriptions/subscriptions.routes";
import { uploadsRouter } from "../modules/uploads/uploads.routes";
import { vendorsRouter } from "../modules/vendors/vendors.routes";

export const apiRouter = Router();

// Swagger UI — enabled unless DISABLE_DOCS=true
// Serves a custom HTML page that loads Swagger UI from CDN (serverless-compatible)
const enableDocs = process.env.DISABLE_DOCS !== "true";
if (enableDocs) {
  apiRouter.get("/docs.json", (_req, res) => {
    res.json(swaggerSpec);
  });

  apiRouter.get("/docs", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Italian Marketplace API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: '/api/docs.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout'
      });
    };
  </script>
</body>
</html>`);
  });
}

apiRouter.use(healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/public/stores", publicStoresRouter);
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
apiRouter.use("/reviews", reviewsRouter);
apiRouter.use("/stripe", stripeRouter);
