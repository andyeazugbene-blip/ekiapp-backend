# Ongoing Operations Report

## Operational Cadence

| Frequency | Task | Owner |
|-----------|------|-------|
| Daily | Morning health check | On-call |
| Daily | Support inbox triage | Support |
| Daily | Sentry error review | Engineering |
| Weekly | Wallet reconciliation | Engineering |
| Weekly | Stripe reconciliation | Engineering |
| Weekly | Metrics review | Product + Engineering |
| Monthly | Disaster recovery drill | Engineering |
| Monthly | Dependency updates | Engineering |
| Quarterly | Security review | Engineering + Security |
| Annually | External pentest | Security vendor |

## Owner Responsibilities

### Engineering (On-call)
- Respond to P1 alerts within 15 minutes
- Run reconciliation scripts weekly
- Deploy fixes for critical bugs same-day
- Maintain health checks and monitoring

### Support
- Respond to tickets within 24h
- Escalate payment issues to engineering
- Process approved refunds
- Document common issues

### Admin
- Approve/reject vendors within 48h
- Resolve disputes within 72h
- Review flagged orders
- Monitor audit logs

## Recurring Checks
```bash
# Daily
npm run launch:health

# Weekly
npm run reconcile:wallets
npm run reconcile:stripe
npm run reconcile:paystack

# Before deploy
npx tsc --noEmit
npx vitest run
```

## Escalation Path
1. **P3 (low):** Fix in next sprint
2. **P2 (medium):** Fix within 48h
3. **P1 (high):** Fix within 4h, notify stakeholders
4. **P0 (critical):** All hands, fix immediately, post-incident review

## Launch Week Monitoring Plan
- Health checks every 2 hours (manual or automated)
- Sentry alerts on phone
- Stripe webhook dashboard open
- Support inbox monitored continuously
- Engineering on standby for first 72 hours
- Daily standup to review metrics
