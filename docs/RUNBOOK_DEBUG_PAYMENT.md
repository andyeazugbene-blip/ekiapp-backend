# Runbook: Debugging a Payment Issue

## Symptoms
- Buyer says "payment failed"
- Order stuck in PENDING
- Vendor not credited
- Refund not processing

## Step 1: Identify the Order
```sql
SELECT id, status, "checkoutId", "vendorId", "totalAmount", currency
FROM "Order" WHERE id = '<orderId>';
```

## Step 2: Check Payment Record
```sql
SELECT id, status, "stripePaymentIntentId", provider, amount
FROM "Payment" WHERE "orderId" = '<orderId>';
```

## Step 3: Check Webhook Events
```sql
SELECT * FROM "WebhookEvent"
WHERE "orderId" = '<checkoutId>' OR "paymentId" = '<paymentId>'
ORDER BY "createdAt" DESC;
```

## Step 4: Check Stripe Dashboard
- Go to: `https://dashboard.stripe.com/test/payments/<pi_id>`
- Verify: status, amount, metadata

## Step 5: Check Vendor Wallet
```sql
SELECT * FROM "WalletTransaction"
WHERE "orderId" = '<orderId>'
ORDER BY "createdAt" DESC;
```

## Common Issues

### Webhook not received
- Check Stripe Dashboard → Webhooks → Event deliveries
- Verify `STRIPE_WEBHOOK_SECRET` matches
- Check Vercel function logs for errors

### Order PENDING but Stripe shows succeeded
- Webhook may have failed — check WebhookEvent table
- Manual fix: process the event manually or run reconciliation

### Vendor not credited
- Check if order is PAID (not just PENDING)
- Check WalletTransaction for PAYMENT_PENDING_CREDIT row
- If missing: webhook processing may have partially failed

### Refund stuck
- Check if `charge.refunded` webhook was received
- Check Stripe Dashboard → Refunds
- Manual fix: update order status + reverse wallet credit
