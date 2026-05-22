import cors from "cors";
import express from "express";
import helmet from "helmet";

// Imported for its init side-effect; Sentry stays disabled if SENTRY_DSN is unset.
import "./lib/sentry";
import { errorHandler } from "./middlewares/error-handler";
import { notFoundHandler } from "./middlewares/not-found";
import { generalRateLimiter } from "./middlewares/rate-limit";
import { requestIdMiddleware } from "./middlewares/request-id";
import { requestLogger } from "./middlewares/request-logger";
import { validateInputLength } from "./middlewares/validate-input-length";
import { getPublicStorePage } from "./modules/public-stores/public-stores.page";
import { apiRouter } from "./routes";

export const app = express();

// Trust first proxy (Vercel, Cloudflare, nginx) for correct req.ip in rate limiting
app.set("trust proxy", 1);

// Security headers — relax CSP for /api/docs (Swagger UI from CDN) and
// /store/:slug (server-rendered public page with inline copy-link script).
app.use((req, res, next) => {
  if (req.path === "/api/docs" || req.path.startsWith("/store/")) {
    return next();
  }
  helmet()(req, res, next);
});

// Request ID (before everything else for tracing)
app.use(requestIdMiddleware);

// CORS — restrict origins in production, allow all in dev.
const isProduction = process.env.NODE_ENV === "production";
const defaultOrigins = ["https://neon.online"];
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : isProduction ? defaultOrigins : undefined;

app.use(
  cors({
    origin: allowedOrigins ?? true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
  }),
);

// Request logging
app.use(requestLogger);

// Body parsing (Stripe webhook needs raw body BEFORE json parser)
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use("/api/paystack/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Rate limiting + input validation
app.use("/api", generalRateLimiter);
app.use(validateInputLength);

// Routes
app.use("/api", apiRouter);

// Root-level OpenAPI spec aliases (for Postman, Insomnia, openapi-generator)
import { swaggerSpec } from "./lib/swagger";
app.get("/openapi.json", (_req, res) => res.json(swaggerSpec));
app.get("/api-json", (_req, res) => res.json(swaggerSpec));
app.get("/swagger.json", (_req, res) => res.json(swaggerSpec));

// Public web routes (server-rendered pages outside /api).
// /store/:slug is the public storefront page used by share links.
app.get("/store/:slug", (req, res, next) => {
  Promise.resolve(getPublicStorePage(req, res)).catch(next);
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Default export for Vercel serverless compatibility
export default app;
