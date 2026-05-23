# Support Runbook

## Support Inbox
- Primary: support@eki.app (or chosen email)
- Auto-reply template: "We received your request (ticket #{id}). We'll respond within 24 hours."

## Refund SLA
- Admin responds within 24 hours
- Approved refunds processed within 3 business days
- Partial refunds require admin approval

## Top 10 Incident Playbooks

### 1. Payment Failed
**Symptoms:** Buyer sees "Payment provider unavailable" or Stripe error.
**Steps:**
1. Check Stripe Dashboard → Payments → find the PI by metadata.checkoutId
2. Check `/api/health/detailed` — is Stripe connectivity OK?
3. If Stripe is down: wait for recovery, buyer can retry
4. If code error: check Sentry for the 502 error, fix and redeploy

### 2. Order Paid But Not Confirmed (Webhook Delayed)
**Symptoms:** Buyer paid, order still PENDING.
**Steps:**
1. Check `WebhookEvent` table for the PI's event
2. If missing: Stripe webhook may not have fired — check Stripe Dashboard → Webhooks → Event deliveries
3. If event shows "failed": verify `STRIPE_WEBHOOK_SECRET` matches
4. Manual fix: find the PI, verify it's succeeded, manually update order to PAID and credit vendor

### 3. Refund Stuck
**Symptoms:** Admin issued refund but order not marked REFUNDED.
**Steps:**
1. Check Stripe Dashboard → Refunds — is the refund succeeded?
2. Check `WebhookEvent` for `charge.refunded` event
3. If webhook not received: check webhook endpoint health
4. Manual fix: update order status to REFUNDED, reverse vendor wallet credit

### 4. Vendor Not Paid (Payout Issue)
**Symptoms:** Vendor's available balance not increasing after order completion.
**Steps:**
1. Check order status — must be COMPLETED (not just PAID)
2. Check `WalletTransaction` for PENDING_TO_AVAILABLE row
3. If missing: admin needs to mark order COMPLETED via `PATCH /admin/orders/:id/complete`
4. For Paystack escrow: check if auto-release or OTP confirmation happened

### 5. Upload Failed
**Symptoms:** Vendor gets error uploading product image.
**Steps:**
1. Check `/api/health/detailed` — is upload returning 503?
2. If 503: R2 env vars not configured on Vercel
3. If 403 on PUT: check R2 bucket CORS policy allows PUT from frontend origin
4. Check Cloudflare R2 dashboard for errors

### 6. Account Locked
**Symptoms:** User gets "Account temporarily locked" on login.
**Steps:**
1. User exceeded 5 failed login attempts
2. Lockout lasts 15 minutes automatically
3. Admin can manually clear: update User set failedLoginAttempts=0, lockedUntil=null

### 7. OTP Not Received
**Symptoms:** User doesn't get verification email.
**Steps:**
1. Check Resend dashboard → Emails → search by recipient
2. If delivered: check spam folder
3. If bounced: email address invalid
4. If Resend is down: check status.resend.com

### 8. Dispute Opened (Escrow)
**Symptoms:** Buyer raised dispute on domestic escrow order.
**Steps:**
1. Check `GET /admin/disputes` for the dispute
2. Review reason, contact both parties
3. Resolve via `PATCH /admin/disputes/:id/resolve` with vendor/buyer/partial

### 9. Paystack Payment Pending
**Symptoms:** Buyer paid via Paystack but order still PENDING.
**Steps:**
1. Check PaystackTransaction table for the reference
2. Verify on Paystack Dashboard → Transactions
3. If succeeded on Paystack but not in DB: webhook may have failed
4. Manual fix: call `GET /api/paystack/verify/:reference` to trigger processing

### 10. Stripe Webhook Delayed
**Symptoms:** Payment succeeded on Stripe but order not updated.
**Steps:**
1. Check Stripe Dashboard → Webhooks → Event deliveries
2. If showing "pending": Stripe will retry automatically
3. If showing "failed": check webhook secret, check Vercel logs for errors
4. Run `npm run reconcile:stripe` to identify mismatches

## First Response Templates

**Payment issue:**
> Hi {name}, I'm looking into your payment for order {orderNumber}. I can see the payment was received and I'm checking why it hasn't been confirmed yet. I'll update you within the hour.

**Refund request:**
> Hi {name}, I've received your refund request for order {orderNumber}. Our team will review it within 24 hours. If approved, the refund will be processed within 3 business days.

**General issue:**
> Hi {name}, thanks for reaching out. I'm looking into this and will get back to you within 24 hours with an update.
