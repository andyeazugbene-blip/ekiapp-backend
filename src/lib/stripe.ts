import https from "https";
import Stripe from "stripe";

import { env } from "../config/env";

const httpsAgent = new https.Agent({ keepAlive: false });

export const stripe = new Stripe(env.stripeSecretKey, {
  httpAgent: httpsAgent,
  timeout: 30000,
  apiVersion: "2025-08-27.basil",
});
