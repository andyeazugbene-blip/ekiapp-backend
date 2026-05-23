# Provider Alerts Live Proof

## Status: EXTERNAL SETUP REQUIRED

## Stripe Alerts

### Dashboard Configuration

1. Go to [Stripe Dashboard](https://dashboard.stripe.com) → Developers → Webhooks
2. Verify webhook endpoint: `https://your-domain.com/api/stripe/webhook`
3. Go to Settings → Team → Notifications

### Required Alert Rules

| Alert | Trigger | Channel | Priority |
|-------|---------|---------|----------|
| Webhook failures | >3 consecutive failures | Email + Slack | HIGH |
| Disputes opened | Any new dispute | Email + Slack | HIGH |
| High-risk payments | Radar risk score >75 | Email | MEDIUM |
| Refund failures | Refund API error | Email + Slack | HIGH |
| Payout failures | Transfer failed | Email + Slack | HIGH |
| Large transactions | Amount >$1000 | Email | LOW |

### Stripe Webhook Events Subscribed

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.dispute.created`
- `charge.dispute.closed`
- `charge.refunded`
- `account.updated` (Connect)
- `payout.failed`

### Setup Steps (Stripe)

1. Dashboard → Settings → Notifications → Email alerts
   - Enable: Disputes, Failed payments, Successful payments (daily digest)
2. Dashboard → Developers → Webhooks → Add endpoint
   - URL: `https://your-domain.com/api/stripe/webhook`
   - Events: all listed above
3. Radar → Rules → Enable enhanced fraud detection
4. Set up Slack integration (Stripe App Marketplace → Slack)

---

## Paystack Alerts

### Dashboard Configuration

1. Go to [Paystack Dashboard](https://dashboard.paystack.com) → Settings → Notifications

### Required Alert Rules

| Alert | Trigger | Channel | Priority |
|-------|---------|---------|----------|
| Failed transactions | Transaction failed | Email | MEDIUM |
| Webhook failures | Webhook delivery failed | Email | HIGH |
| Settlement notifications | Daily settlement processed | Email | LOW |
| Transfer failures | Payout transfer failed | Email + Slack | HIGH |
| Chargeback/Dispute | Customer disputes charge | Email | HIGH |

### Paystack Webhook Events Subscribed

- `charge.success`
- `transfer.success`
- `transfer.failed`
- `refund.processed`

### Setup Steps (Paystack)

1. Dashboard → Settings → Notifications
   - Enable: Failed charges, Successful charges (daily), Transfers
2. Dashboard → Settings → API Keys & Webhooks
   - Webhook URL: `https://your-domain.com/api/paystack/webhook`
   - Verify events are being received
3. Dashboard → Transfers → Enable transfer notifications
4. Set up email forwarding to ops team

---

## Resend (Email Provider) Alerts

### Dashboard Configuration

1. Go to [Resend Dashboard](https://resend.com/overview)

### Required Alert Rules

| Alert | Trigger | Channel | Priority |
|-------|---------|---------|----------|
| Delivery failures | Bounce rate >5% | Email | HIGH |
| Domain issues | SPF/DKIM failure | Email | HIGH |
| Rate limit approaching | >80% of plan limit | Email | MEDIUM |
| Suppression list additions | Hard bounces | Email | LOW |

### Setup Steps (Resend)

1. Dashboard → Domains → Verify SPF, DKIM, DMARC records
2. Dashboard → Webhooks → Add endpoint for bounce/complaint tracking
3. Set up daily digest of delivery metrics
4. Monitor suppression list weekly

---

## Sentry Alerts (Application Errors)

| Alert | Trigger | Channel | Priority |
|-------|---------|---------|----------|
| New issue | First occurrence | Slack | MEDIUM |
| Error spike | >5x baseline in 5 min | Slack + Email | HIGH |
| Payment errors | Error contains "Stripe" or "Paystack" | Slack + PagerDuty | CRITICAL |
| Unhandled rejection | Unhandled promise rejection | Slack | HIGH |

---

## Verification Checklist

### Stripe
- [ ] Webhook endpoint configured and receiving events
- [ ] Dispute notifications enabled
- [ ] Failed payment notifications enabled
- [ ] Slack integration active

### Paystack
- [ ] Webhook endpoint configured and receiving events
- [ ] Failed transaction notifications enabled
- [ ] Transfer failure notifications enabled
- [ ] Settlement notifications enabled

### Resend
- [ ] Domain verified (SPF, DKIM, DMARC)
- [ ] Bounce webhook configured
- [ ] Delivery rate monitored

### Sentry
- [ ] Alert rules configured
- [ ] Slack integration active
- [ ] Payment-specific alerts set up

---

## Monitoring Dashboard

Recommended: Create a unified ops dashboard with:
- Stripe webhook success rate (last 24h)
- Paystack transaction success rate
- Email delivery rate
- Sentry error count
- API response time (p95)
- Database connection pool usage
