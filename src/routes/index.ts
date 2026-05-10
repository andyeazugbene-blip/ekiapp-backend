import { Router } from "express";
import swaggerUi from "swagger-ui-express";

import { swaggerSpec } from "../lib/swagger";
import { adminRouter } from "../modules/admin/admin.routes";
import { authRouter } from "../modules/auth/auth.routes";
import { cartRouter } from "../modules/cart/cart.routes";
import { deliveryRouter } from "../modules/delivery/delivery.routes";
import { healthRouter } from "../modules/health/health.routes";
import { notificationsRouter } from "../modules/notifications/notifications.routes";
import { paymentsRouter } from "../modules/payments/payments.routes";
import { payoutRequestsRouter } from "../modules/payouts/payouts.routes";
import { productsRouter } from "../modules/products/products.routes";
import { stripeRouter } from "../modules/stripe/stripe.routes";
import { vendorsRouter } from "../modules/vendors/vendors.routes";

export const apiRouter = Router();

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

apiRouter.use(healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/vendors", vendorsRouter);
apiRouter.use("/products", productsRouter);
apiRouter.use("/cart", cartRouter);
apiRouter.use("/delivery", deliveryRouter);
apiRouter.use("/payments", paymentsRouter);
apiRouter.use("/payout-requests", payoutRequestsRouter);
apiRouter.use("/notifications", notificationsRouter);
apiRouter.use("/stripe", stripeRouter);
