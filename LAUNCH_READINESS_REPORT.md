# Launch Readiness Report

## What Was Implemented

### Error Monitoring (Sentry)
- `src/lib/sentry.ts` — Sentry SDK initialized when `SENTRY_DSN` is set
- Error handler captures all 5xx errors with requestId, userId, path, method
- Set `SENTRY_DSN` in Vercel to enable

### Health Check
- `GET /api/health` — simple 200 OK
- `GET /api/health/detailed` — checks database, Stripe, Paystack connectivity
  - Returns 200 if critical services (DB + Stripe) are up
  - Returns 503 if any critical service is down
  - JSON response with per-service status and latency

### Deployment Checklist
- `DEPLOYMENT_CHECKLIST.md` — covers backup, rotation, rollback, env vars

### Reconciliation Scripts
- `npm run reconcile:wallets` — compares wallet balances vs transaction ledger
- `npm run reconcile:stripe` — compares Stripe PIs vs DB checkouts (last 24h)
- `npm run reconcile:paystack` — compares Paystack transactions vs DB (last 24h)

### Launch Health Check
- `npm run launch:health` — verifies all production endpoints are operational

### Structured Logging
- Already implemented: JSON structured logger with level, timestamp, requestId
- All payment, webhook, wallet, and refund actions are logged

---

## How to Run

```bash
# Pre-deploy verification
npx prisma generate
npx tsc --noEmit
npx vitest run

# Production health check
npm run launch:health

# Reconciliation (safe to run anytime)
npm run reconcile:wallets
npm run reconcile:stripe
npm run reconcile:paystack
```

---

## Env Vars Needed for Launch

| Variable | Purpose |
|----------|---------|
| `SENTRY_DSN` | Error monitoring (create project at sentry.io) |
| All others | Already documented in DEPLOYMENT_CHECKLIST.md |

---

## Non-Code Launch Tasks (Business/Legal/Frontend)

These are NOT backend engineering tasks but are required for a compliant EU marketplace launch:

- [ ] **Terms of Service** — legal document, hosted at a URL
- [ ] **Privacy Policy** — GDPR-compliant, hosted at a URL
- [ ] **Cookie Banner** — frontend implementation
- [ ] **Support Inbox** — email or helpdesk for buyer/vendor issues
- [ ] **Status Page** — e.g. Instatus, Betteruptime, or similar
- [ ] **VAT/Tax Configuration** — EU VAT rules for digital marketplaces
- [ ] **Admin 2FA** — frontend implementation for admin accounts
- [ ] **App Store Compliance** — privacy labels, permissions justification
- [ ] **Domain SSL** — neon.online pointed at Vercel with HTTPS
- [ ] **Stripe Account Activation** — move from test to live mode
- [ ] **Paystack Account Activation** — move from test to live mode
- [ ] **Email Domain Verification** — verify sending domain in Resend for deliverability
