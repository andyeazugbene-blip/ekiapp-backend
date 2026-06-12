import https from "https";
import Stripe from "stripe";

import { env } from "../config/env";

// Vercel serverless: use keepAlive: false to prevent connection reuse issues
const httpsAgent = new https.Agent({ keepAlive: false });

export const stripe = new Stripe(env.stripeSecretKey, {
  httpAgent: httpsAgent,
  timeout: 30000,
});
