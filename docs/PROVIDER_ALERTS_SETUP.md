# Provider Dashboard Alerts Setup

## Stripe (dashboard.stripe.com)

### Webhook Failures
- Navigate: Developers → Webhooks → your endpoint
- Enable email alerts for failed deliveries
- Alert if 3+ consecutive failures

### Disputes
- Navigate: Payments → Disputes
- Enable email notification for new disputes
- Respond within 7 days (Stripe deadline)

### High-Risk Payments
- Navigate: Radar → Rules
- Enable alerts for payments flagged as high risk
- Review manually before fulfillment

### Refund Failures
- Monitor via Stripe webhook: `charge.refund.updated` with status=failed
- Backend logs these in Sentry

## Paystack (dashboard.paystack.co)

### Failed Transactions
- Navigate: Transactions → filter by Failed
- Set up email alerts if available
- Check daily during soft launch

### Webhook Delivery Failures
- Navigate: Settings → Webhooks → Delivery logs
- Alert if deliveries are failing (check daily)

### Settlement Failures
- Navigate: Settlements
- Alert if settlement is delayed beyond 24h

## Resend (resend.com)

### Delivery Failures
- Navigate: Emails → filter by bounced/failed
- Monitor domain reputation
- Alert if bounce rate exceeds 5%

### Domain Issues
- Navigate: Domains → check DNS status
- Alert if SPF/DKIM/DMARC fails

## Cloudflare R2

### Upload Error Monitoring
- Check R2 analytics in Cloudflare dashboard
- Monitor Class A operations (writes) for spikes
- No built-in alerting — use health check script as proxy
