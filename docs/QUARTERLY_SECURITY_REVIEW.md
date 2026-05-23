# Quarterly Security Review

## Dependency Audit
- [ ] Run `npm audit` — fix critical/high vulnerabilities
- [ ] Run `npx npm-check-updates` — review outdated packages
- [ ] Check Dependabot/Snyk alerts on GitHub
- [ ] Update Stripe SDK if new version available
- [ ] Update Prisma if new version available

## Auth & Rate Limiting
- [ ] Review rate limit thresholds (auth: 10/15min, general: 100/min)
- [ ] Check for accounts with >50 failed login attempts (potential brute force)
- [ ] Review JWT expiry (currently 7d) — still appropriate?
- [ ] Verify bcrypt rounds still at 12+
- [ ] Check for any hardcoded secrets in codebase

## Payment Webhook Security
- [ ] Verify Stripe webhook signature validation working
- [ ] Verify Paystack webhook HMAC validation working
- [ ] Check WebhookEvent table for unusual patterns
- [ ] Review refund audit logs for anomalies

## Admin Permissions
- [ ] List all admin accounts — are they all legitimate?
- [ ] Review admin audit logs for unusual actions
- [ ] Check for admin accounts that haven't logged in >90 days (disable)

## Vendor Payout Review
- [ ] Check for vendors with unusually high payout frequency
- [ ] Verify no vendor has negative wallet balance
- [ ] Run `npm run reconcile:wallets` — all pass?

## Annual External Pentest
- Recommended: engage external security firm annually
- Scope: API endpoints, authentication, payment flows, file uploads
- Budget: allocate before each anniversary

## Sign-off
- Reviewer: ____
- Date: ____
- Issues found: ____
- Action items: ____
