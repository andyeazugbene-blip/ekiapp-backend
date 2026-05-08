import { Router } from "express";

import { healthRouter } from "../modules/health/health.routes";
import { paymentsRouter } from "../modules/payments/payments.routes";
import { stripeRouter } from "../modules/stripe/stripe.routes";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use("/payments", paymentsRouter);
apiRouter.use("/stripe", stripeRouter);
