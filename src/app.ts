import cors from "cors";
import express from "express";
import helmet from "helmet";

// Imported for its init side-effect; Sentry stays disabled if SENTRY_DSN is unset.
import "./lib/sentry";
import { swaggerSpec } from "./lib/swagger";
import { errorHandler } from "./middlewares/error-handler";
import { notFoundHandler } from "./middlewares/not-found";
import { generalRateLimiter } from "./middlewares/rate-limit";
import { requestIdMiddleware } from "./middlewares/request-id";
import { requestLogger } from "./middlewares/request-logger";
import { validateInputLength } from "./middlewares/validate-input-length";
import {
  getPublicAccountDeletionPage,
  getPublicFindOrderPage,
  getPublicHelpPage,
  getPublicHomePage,
  getPublicPrivacyPage,
  getPublicSupportPage,
  getPublicTermsPage,
  requestPublicOrderLookup,
  verifyPublicOrderLookup,
} from "./modules/public-site/public-site.page";
import {
  getPublicStoreDirectoryPage,
  getPublicStoreCheckoutPage,
  getPublicStoreConfirmedPage,
  getPublicStorePage,
  getPublicStoreProductPage,
  getPublicStoreTrackedOrderPage,
} from "./modules/public-stores/public-stores.page";
import { apiRouter } from "./routes";

export const app = express();

// Trust first proxy (Vercel, Cloudflare, nginx) for correct req.ip in rate limiting
app.set("trust proxy", 1);

// Hide the default `X-Powered-By: Express` header on every response.
// Helmet does this for routes it runs on, but the bypass below for
// /api/docs and public HTML pages skips the default CSP path, so we set it
// at the app level to cover both paths in one place.
app.disable("x-powered-by");

// Security headers. CSP must be relaxed on /api/docs and server-rendered
// public HTML pages that use inline scripts.
const publicHtmlPaths = new Set(["/", "/find-order", "/help", "/support", "/privacy", "/terms", "/account-deletion"]);
const swaggerAndPublicPagePaths = (req: { path: string }) =>
  req.path === "/api/docs" || req.path.startsWith("/store/") || publicHtmlPaths.has(req.path);

app.use((req, res, next) => {
  if (swaggerAndPublicPagePaths(req)) {
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    })(req, res, next);
    return;
  }
  helmet()(req, res, next);
});

// Request ID (before everything else for tracing)
app.use(requestIdMiddleware);

// CORS - restrict origins in production, allow all in dev.
const isProduction = process.env.NODE_ENV === "production";
const defaultOrigins = [
  "https://culinarytales.app",
  "https://www.culinarytales.app",
  "https://ekiapp-backend.vercel.app",
];
const localAdminOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];
const configuredOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  : [];
const allowedOrigins = isProduction
  ? Array.from(new Set([...defaultOrigins, ...configuredOrigins, ...localAdminOrigins]))
  : undefined;

app.use(
  cors({
    origin: allowedOrigins ?? true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "x-2fa-code", "X-Client-App", "X-Client-Platform"],
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
app.post("/api/public/order-lookup/request", (req, res, next) => {
  Promise.resolve(requestPublicOrderLookup(req, res)).catch(next);
});
app.post("/api/public/order-lookup/verify", (req, res, next) => {
  Promise.resolve(verifyPublicOrderLookup(req, res)).catch(next);
});

// Root-level OpenAPI spec aliases (for Postman, Insomnia, openapi-generator)
app.get("/openapi.json", (_req, res) => res.json(swaggerSpec));
app.get("/api-json", (_req, res) => res.json(swaggerSpec));
app.get("/swagger.json", (_req, res) => res.json(swaggerSpec));

// Public web routes (server-rendered pages outside /api).
app.get("/", (req, res, next) => {
  Promise.resolve(getPublicHomePage(req, res)).catch(next);
});
app.get("/find-order", (req, res, next) => {
  Promise.resolve(getPublicFindOrderPage(req, res)).catch(next);
});
app.get("/help", (req, res, next) => {
  Promise.resolve(getPublicHelpPage(req, res)).catch(next);
});
app.get("/support", (req, res, next) => {
  Promise.resolve(getPublicSupportPage(req, res)).catch(next);
});
app.get("/privacy", (req, res, next) => {
  Promise.resolve(getPublicPrivacyPage(req, res)).catch(next);
});
app.get("/terms", (req, res, next) => {
  Promise.resolve(getPublicTermsPage(req, res)).catch(next);
});
app.get("/account-deletion", (req, res, next) => {
  Promise.resolve(getPublicAccountDeletionPage(req, res)).catch(next);
});
app.get("/store", (req, res, next) => {
  Promise.resolve(getPublicStoreDirectoryPage(req, res)).catch(next);
});
app.get("/store/:slug", (req, res, next) => {
  Promise.resolve(getPublicStorePage(req, res)).catch(next);
});
app.get("/store/:slug/product/:productId", (req, res, next) => {
  Promise.resolve(getPublicStoreProductPage(req, res)).catch(next);
});
app.get("/store/:slug/checkout", (req, res, next) => {
  Promise.resolve(getPublicStoreCheckoutPage(req, res)).catch(next);
});
app.get("/store/:slug/confirmed", (req, res, next) => {
  Promise.resolve(getPublicStoreConfirmedPage(req, res)).catch(next);
});
app.get("/store/:slug/track/:orderNumber", (req, res, next) => {
  Promise.resolve(getPublicStoreTrackedOrderPage(req, res)).catch(next);
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Default export for Vercel serverless compatibility
export default app;
