import { app } from "../src/app";

// Vercel Node.js Serverless Function entrypoint. Vercel does not parse the body
// for plain Node functions, so Express's own raw/json parsers work as-is
// (including the Stripe webhook raw body parser mounted in src/app.ts).
export default app;
