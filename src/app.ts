import cors from "cors";
import express from "express";
import helmet from "helmet";
import path from "path";
import { bootstrapAdmin } from "./modules/admin/admin-bootstrap";
import { adminRolesService } from "./modules/admin/admin-roles.service";

// Imported for its init side-effect; Sentry stays disabled if SENTRY_DSN is unset.
import "./lib/sentry";
import { swaggerSpec } from "./lib/swagger";
import { errorHandler } from "./middlewares/error-handler";
import { notFoundHandler } from "./middlewares/not-found";
import { adminRateLimiter, generalRateLimiter } from "./middlewares/rate-limit";
import { resolveCorsOrigins } from "./config/cors";
import { logger } from "./lib/logger";
import { requestIdMiddleware } from "./middlewares/request-id";
import { requestLogger } from "./middlewares/request-logger";
import { validateInputLength } from "./middlewares/validate-input-length";
import {
  getPublicAccountDeletionPage,
  getPublicFindOrderPage,
  getPublicHelpPage,
  getPublicHomePage,
  getPublicSellPage,
  getPublicInvitePage,
  getStripeConnectReturnPage,
  getPublicPrivacyPage,
  getPublicTermsPage,
  getPublicRefundPolicyPage,
  getPublicCookiePolicyPage,
  getPublicSubscriptionPolicyPage,
  getPublicAcceptableUsePage,
  getPublicVendorAgreementPage,
  getPublicVendorSubscriptionPage,
  getPublicVendorPortalPage,
  getPublicBuyerCartPage,
} from "./modules/public-site/public-site.page";
import {
  getPublicStoreCheckoutPage,
  getPublicStoreCartPage,
  getPublicStoreConfirmedPage,
  getPublicStoreDirectoryPage,
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
const publicHtmlPaths = new Set(["/", "/sell", "/find-order", "/help", "/support", "/privacy", "/terms", "/account-deletion", "/refund-policy", "/cookie-policy", "/subscription-policy", "/acceptable-use", "/vendor-agreement", "/vendor/subscription", "/vendor", "/cart", "/checkout", "/business-portal"]);
const swaggerAndPublicPagePaths = (req: { path: string }) =>
  req.path === "/api/docs" || req.path.startsWith("/store") || req.path.startsWith("/invite/") || publicHtmlPaths.has(req.path);

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
const corsResolution = resolveCorsOrigins(process.env, isProduction);
if (corsResolution.rejected.length > 0) {
  logger.warn("CORS: ignored invalid origin entries (must be exact https origins, no wildcard/path)", { rejected: corsResolution.rejected });
}
if (corsResolution.source === "CORS_ORIGIN") {
  logger.warn("CORS: using legacy CORS_ORIGIN; rename it to CORS_ORIGINS");
}
const allowedOrigins = corsResolution.origins === true ? undefined : corsResolution.origins;

app.use(
  cors({
    origin: allowedOrigins ?? true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // X-Client-App/X-Client-Platform are sent by services/api/client.ts on
    // every request, including from the web build (Platform.OS === "web") —
    // missing from this list meant any browser-origin caller failed CORS
    // preflight outright (native app requests aren't subject to browser
    // CORS, so this only ever affected web).
    // x-2fa-code is sent by admin-web (lib/api.ts) on the automatic retry
    // of any 2FA-gated admin action (e.g. POST /admin/admins/invite) —
    // missing from this list meant the browser blocked that retry at the
    // CORS preflight stage, before it ever reached the server, which
    // surfaced to the admin as a bare "Network error" with no server log
    // at all (bug report 2026-10-05: "super admin can't invite by email").
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "x-job-secret", "X-Client-App", "X-Client-Platform", "x-2fa-code"],
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
app.use("/api", adminRateLimiter);
app.use(validateInputLength);

// Routes
app.use("/api", apiRouter);

// Root-level OpenAPI spec aliases (for Postman, Insomnia, openapi-generator)
app.get("/openapi.json", (_req, res) => res.json(swaggerSpec));
app.get("/api-json", (_req, res) => res.json(swaggerSpec));
app.get("/swagger.json", (_req, res) => res.json(swaggerSpec));

app.get("/assets/public-site/hero-phone-mockup.jpg", (_req, res) => {
  res.type("jpeg").sendFile(path.join(__dirname, "modules/public-site/hero-phone-mockup.jpg"));
});
app.get("/assets/public-site/hero-phone-mockup.png", (_req, res) => {
  res.type("png").sendFile(path.join(__dirname, "modules/public-site/hero-phone-mockup.png"));
});

// Public web routes (server-rendered pages outside /api).
app.get("/", (req, res, next) => {
  Promise.resolve(getPublicHomePage(req, res)).catch(next);
});
app.get("/sell", (req, res, next) => {
  Promise.resolve(getPublicSellPage(req, res)).catch(next);
});
app.get("/find-order", (req, res, next) => {
  Promise.resolve(getPublicFindOrderPage(req, res)).catch(next);
});
app.get("/help", (req, res, next) => {
  Promise.resolve(getPublicHelpPage(req, res)).catch(next);
});
app.get("/support", (req, res, next) => {
  Promise.resolve(getPublicHelpPage(req, res)).catch(next);
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
app.get("/refund-policy", (req, res, next) => {
  Promise.resolve(getPublicRefundPolicyPage(req, res)).catch(next);
});
app.get("/cookie-policy", (req, res, next) => {
  Promise.resolve(getPublicCookiePolicyPage(req, res)).catch(next);
});
app.get("/subscription-policy", (req, res, next) => {
  Promise.resolve(getPublicSubscriptionPolicyPage(req, res)).catch(next);
});
app.get("/acceptable-use", (req, res, next) => {
  Promise.resolve(getPublicAcceptableUsePage(req, res)).catch(next);
});
app.get("/vendor-agreement", (req, res, next) => {
  Promise.resolve(getPublicVendorAgreementPage(req, res)).catch(next);
});
app.get("/invite/:code", (req, res, next) => {
  Promise.resolve(getPublicInvitePage(req, res)).catch(next);
});
// Stripe Connect refresh_url/return_url targets (vendor + Community Buy
// supplier onboarding) — see getStripeConnectReturnPage's doc comment.
app.get("/vendor/stripe-connect", (req, res, next) => {
  Promise.resolve(getStripeConnectReturnPage(req, res)).catch(next);
});
app.get("/supplier/stripe-connect", (req, res, next) => {
  Promise.resolve(getStripeConnectReturnPage(req, res)).catch(next);
});
app.get("/vendor/subscription", (req, res, next) => {
  Promise.resolve(getPublicVendorSubscriptionPage(req, res)).catch(next);
});
app.get("/business-portal", (req, res, next) => {
  Promise.resolve(getPublicVendorSubscriptionPage(req, res)).catch(next);
});
app.get("/vendor", (req, res, next) => {
  Promise.resolve(getPublicVendorPortalPage(req, res)).catch(next);
});
app.get("/checkout",(req,res,next)=>{Promise.resolve(require("./modules/public-site/public-site.page").getPublicCheckoutPage(req,res)).catch(next)});
app.get("/cart", (req, res, next) => {
  Promise.resolve(getPublicBuyerCartPage(req, res)).catch(next);
});
app.get("/store", (req, res, next) => {
  Promise.resolve(getPublicStoreDirectoryPage(req, res)).catch(next);
});
app.get("/store/:slug/product/:productId", (req, res, next) => {
  Promise.resolve(getPublicStoreProductPage(req, res)).catch(next);
});
app.get("/store/:slug/checkout", (req, res, next) => {
  Promise.resolve(getPublicStoreCheckoutPage(req, res)).catch(next);
});
app.get("/store/:slug/cart", (req, res, next) => {
  Promise.resolve(getPublicStoreCartPage(req, res)).catch(next);
});
app.get("/store/:slug/confirmed", (req, res, next) => {
  Promise.resolve(getPublicStoreConfirmedPage(req, res)).catch(next);
});
app.get("/store/:slug/order/:orderNumber", (req, res, next) => {
  Promise.resolve(getPublicStoreTrackedOrderPage(req, res)).catch(next);
});
app.get("/store/:slug/track/:orderNumber", (req, res, next) => {
  Promise.resolve(getPublicStoreTrackedOrderPage(req, res)).catch(next);
});
app.get("/store/:slug", (req, res, next) => {
  Promise.resolve(getPublicStorePage(req, res)).catch(next);
});

// Apple App Site Association for deep linking (Universal Links)
app.get("/.well-known/apple-app-site-association", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({
    applinks: {
      apps: [],
      details: [
        {
          // appID must be <AppleTeamID>.<BundleID> — 83BMQKN6K7 is the real
          // Apple Developer Team ID (EHIMA GROUP LTD), confirmed directly
          // from a signed EAS iOS build's credentials output. The previous
          // value here was the numeric App Store Connect app ID
          // (6776307497, matches eas.json's ascAppId), which is a different
          // identifier — Apple validates the team-ID prefix against the
          // app's actual code-signing team, so the wrong value silently
          // failed Universal Links validation on real devices (tapping a
          // culinarytales.app link always fell back to Safari).
          appID: "83BMQKN6K7.com.ekiapp.mobilee",
          // /community-buy/* — Community Buy share links
          // (getPublicCommunityBuyUrl() in the mobile app) point at
          // /community-buy/:campaignId and were missing from this list.
          paths: ["/store/*", "/product/*", "/order/*", "/chat/*", "/invite/*", "/find-order", "/community-buy/*"],
        },
      ],
    },
  });
});
app.get("/apple-app-site-association", (_req, res) => {
  res.redirect(301, "/.well-known/apple-app-site-association");
});

// Bootstrap admin on first request (before error handlers)
let bootstrapped = false;
app.use((_req, _res, next) => {
  if (!bootstrapped) {
    bootstrapped = true;
    bootstrapAdmin().catch(() => {});
    adminRolesService.seedDefaultRoles().catch(() => {});
  }
  next();
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);


// Default export for Vercel serverless compatibility
export default app;
