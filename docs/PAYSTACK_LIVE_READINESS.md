# Paystack Live Readiness

## Status: EXTERNAL SETUP REQUIRED (Live key not configured)

## Current Implementation

| Feature | Status | File |
|---------|--------|------|
| Transaction initialization | ✅ | `src/lib/paystack.ts` |
| Transaction verification | ✅ | `src/lib/paystack.ts` |
| Webhook handling (HMAC SHA-512) | ✅ | `src/modules/paystack/paystack.controller.ts` |
| Webhook signature validation | ✅ | Returns 400 on invalid signature |
| Transfer recipients (payouts) | ✅ | `src/lib/paystack.ts` |
| Transfer initiation | ✅ | `src/lib/paystack.ts` |
| Refund support | ✅ | `src/lib/paystack.ts` |
| Account resolution | ✅ | `src/lib/paystack.ts` |
| Escrow flow (hold → release) | ✅ | `src/modules/paystack/` |
| Dispute management | ✅ | `src/modules/paystack/dispute.controller.ts` |
| Trust score system | ✅ | `src/modules/paystack/trust-score.controller.ts` |
| Health check | ✅ | `src/modules/health/health.controller.ts` |
| Reconciliation script | ✅ | `scripts/reconcile-paystack.ts` |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYSTACK_SECRET_KEY` | Yes (for Paystack features) | Live secret key from Paystack dashboard |
| `PAYSTACK_PUBLIC_KEY` | Yes (frontend) | Public key for frontend widget |
| `ESCROW_AUTO_RELEASE_HOURS` | No (default: 24) | Hours before auto-releasing escrow |
| `ESCROW_VENDOR_TIMEOUT_HOURS` | No (default: 48) | Hours vendor has to confirm |

## Webhook Security

The webhook endpoint (`POST /api/paystack/webhook`) validates:
1. Raw body is parsed (express.raw middleware applied before JSON parser)
2. HMAC SHA-512 signature verified against `PAYSTACK_SECRET_KEY`
3. Invalid signature → 400 response (tested)
4. Idempotency via `WebhookEvent` table (prevents duplicate processing)

## Go-Live Steps

### 1. Get Live Keys
1. Log in to [Paystack Dashboard](https://dashboard.paystack.com)
2. Go to Settings → API Keys & Webhooks
3. Copy **Live Secret Key** and **Live Public Key**

### 2. Configure Webhook URL
1. In Paystack Dashboard → Settings → API Keys & Webhooks
2. Set Webhook URL: `https://your-domain.com/api/paystack/webhook`
3. Events to subscribe: `charge.success`, `transfer.success`, `transfer.failed`, `refund.processed`

### 3. Set Vercel Environment Variables
```
PAYSTACK_SECRET_KEY=sk_live_xxxxx
PAYSTACK_PUBLIC_KEY=pk_live_xxxxx
```

### 4. Verify
```bash
# Health check
curl https://your-domain.com/api/health/detailed | jq .checks.paystack

# Reconciliation
npm run reconcile:paystack
```

### 5. Test Webhook Signature Rejection
```bash
curl -X POST https://your-domain.com/api/paystack/webhook \
  -H "Content-Type: application/json" \
  -H "x-paystack-signature: invalid_signature" \
  -d '{"event":"charge.success","data":{}}' \
  -w "\n%{http_code}"
# Expected: 400
```

## Graceful Degradation

If `PAYSTACK_SECRET_KEY` is not set:
- `paystack.isConfigured()` returns `false`
- Health check shows `"paystack": { "status": "skipped" }`
- Paystack endpoints will fail with clear error messages
- Stripe payments continue to work independently

## Reconciliation

Run `npm run reconcile:paystack` to:
- Compare local PaystackTransaction records against Paystack API
- Flag discrepancies (amount mismatch, status mismatch)
- Report unmatched transactions
