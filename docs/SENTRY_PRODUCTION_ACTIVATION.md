# Sentry Production Activation

## Status: EXTERNAL SETUP REQUIRED

## Current Implementation

Sentry is fully integrated in the backend:
- **SDK**: `@sentry/node` v10.52.0
- **Init**: `src/lib/sentry.ts` — initializes if `SENTRY_DSN` is set, no-op otherwise
- **Error capture**: `src/middlewares/error-handler.ts` — captures all 500 errors with:
  - `requestId` (from `x-request-id` header)
  - `userId` (from authenticated user)
  - `method`, `path` context
- **Test endpoint**: `GET /api/health/sentry-test` — triggers a safe 500 to verify capture

## Vercel Environment Setup

1. Go to [Vercel Dashboard](https://vercel.com) → Project → Settings → Environment Variables
2. Add:
   | Variable | Value | Environments |
   |----------|-------|--------------|
   | `SENTRY_DSN` | `https://xxx@xxx.ingest.sentry.io/xxx` | Production, Preview |
3. Redeploy the project

## Verification Steps

1. After setting `SENTRY_DSN`, redeploy
2. Hit `GET https://your-domain.com/api/health/sentry-test`
3. Check Sentry dashboard — you should see:
   - Error: `[Sentry Test] Verification error — safe to ignore`
   - Tags: `requestId`, `userId` (if authenticated)
   - Environment: `production`

## Alert Rule Setup (Sentry Dashboard)

1. Go to Sentry → Alerts → Create Alert Rule
2. **First occurrence of new issue**: Notify via email/Slack
3. **High-frequency errors**: >10 events in 5 minutes → PagerDuty/Slack
4. **Recommended rules**:
   - All new issues → Slack `#alerts-backend`
   - Error rate spike (>5x baseline) → PagerDuty
   - Specific: `Payment` or `Stripe` or `Paystack` in title → immediate escalation

## What's Already Done

- [x] SDK installed and configured
- [x] Error handler sends exceptions with context
- [x] Test endpoint available
- [x] Graceful degradation when DSN not set

## What Requires External Action

- [ ] Create Sentry project (if not done)
- [ ] Set `SENTRY_DSN` in Vercel environment variables
- [ ] Configure alert rules in Sentry dashboard
- [ ] Verify capture with test endpoint
