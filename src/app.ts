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
import { apiRouter } from "./routes";

export const app = express();

// Trust first proxy (Vercel, Cloudflare, nginx) for correct req.ip in rate limiting
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// Request ID (before everything else for tracing)
app.use(requestIdMiddleware);

// CORS — restrict origins in production, allow all in dev.
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : undefined;

if (isProduction && !allowedOrigins) {
  // In production, CORS_ORIGINS must be set. Fail-closed: reject all cross-origin.
  app.use(
    cors({
      origin: false,
      credentials: true,
    }),
  );
} else {
  app.use(
    cors({
      origin: allowedOrigins ?? true,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    }),
  );
}

// Request logging
app.use(requestLogger);

// Body parsing (Stripe webhook needs raw body BEFORE json parser)
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Rate limiting + input validation
app.use("/api", generalRateLimiter);
app.use(validateInputLength);

// Routes
app.use("/api", apiRouter);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);
