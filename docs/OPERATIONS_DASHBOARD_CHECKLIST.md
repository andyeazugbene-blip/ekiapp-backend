# Operations Dashboard — Daily Checklist

## Morning Check (5 min)
- [ ] Sentry: any new unresolved errors?
- [ ] Health check: `npm run launch:health` → all green?
- [ ] Stripe Dashboard: any failed webhooks in last 24h?
- [ ] Support inbox: any unread tickets?

## Midday Check (2 min)
- [ ] Wallet reconciliation: `npm run reconcile:wallets` → PASS?
- [ ] Any disputes needing action? (`GET /admin/disputes?status=OPEN`)

## End of Day (3 min)
- [ ] Refunds past SLA? (any refund request older than 24h without response)
- [ ] Admin audit log: any unusual actions?
- [ ] Upload failures in last 24h?

## Weekly (Friday)
- [ ] Run `npm run reconcile:stripe`
- [ ] Run `npm run reconcile:paystack`
- [ ] Fill out Weekly Metrics Review template
- [ ] Review Sentry error trends

## Launch Week (Extra Monitoring)
- [ ] Check health every 2 hours
- [ ] Monitor Stripe webhook delivery in real-time
- [ ] Watch for rate limit triggers (may need to adjust for launch traffic)
- [ ] Be available for vendor onboarding support
- [ ] Document any issues for post-launch review
