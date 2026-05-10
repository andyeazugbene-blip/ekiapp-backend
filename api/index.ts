import type { IncomingMessage, ServerResponse } from "http";

import { app } from "../src/app";

// Vercel Node.js Serverless Function entrypoint.
// Wrapping the Express app in an explicit (req, res) handler ensures the
// default export is unambiguously a function, satisfying @vercel/node's
// "default export must be a function or server" check.
//
// Vercel does not pre-parse the body for plain Node functions, so Express's
// own raw/json parsers (including the Stripe webhook raw body parser mounted
// in src/app.ts) work as-is.
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req as never, res as never);
}
