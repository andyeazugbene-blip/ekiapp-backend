# Soft Launch Readiness Report

## Status: ✅ SOFT LAUNCH READY (for 20–50 invited users)

## What Is Implemented (Code)
- ✅ Production health checks (DB + Stripe + Paystack)
- ✅ Structured JSON logging with requestId
- ✅ Sentry error capture on all 5xx (set SENTRY_DSN to enable)
- ✅ Wallet ledger reconciliation script
- ✅ Stripe reconciliation script
- ✅ Paystack reconciliation script
- ✅ Launch health check script
- ✅ Load smoke test script
- ✅ Refund flow (Stripe + Paystack)
- ✅ Webhook idempotency (both providers)
- ✅ Per-vendor currency model
- ✅ R2 uploads working
- ✅ 284 automated tests passing

## What Requires Manual Dashboard Setup
- [ ] Set `SENTRY_DSN` in Vercel (create Sentry project first)
- [ ] Configure status page (BetterStack/Instatus)
- [ ] Set up Stripe webhook failure alerts
- [ ] Set up support inbox (support@eki.app)
- [ ] Configure Paystack live credentials (when ready for Africa)

## What Requires Legal/Frontend/Business Action
- [ ] Terms of Service document
- [ ] Privacy Policy document
- [ ] Cookie consent banner (frontend)
- [ ] VAT registration (consult tax advisor)
- [ ] Support email auto-reply setup
- [ ] Vendor onboarding documentation for vendors

## Go/No-Go Checklist (20–50 Users)
- [x] API responds to health checks
- [x] Payments work end-to-end (Stripe test mode verified)
- [x] Refunds work
- [x] Uploads work
- [x] Auth + RBAC enforced
- [x] Reconciliation scripts pass
- [ ] SENTRY_DSN configured
- [ ] Support inbox active
- [ ] At least 1 verified vendor with real products
- [ ] Admin account secured with strong password
