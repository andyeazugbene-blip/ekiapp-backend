# Deployment & Operations Checklist

## Database (Neon)

- [ ] PITR (Point-in-Time Recovery) enabled on Neon project
- [ ] Daily logical backup configured (pg_dump via GitHub Action or Neon branch)
- [ ] Restore drill: create a Neon branch from 24h ago, verify data integrity
- [ ] Connection pooling enabled (pooler endpoint in DATABASE_URL)
- [ ] `connection_limit=1` in DATABASE_URL for serverless

## Storage (Cloudflare R2)

- [ ] Bucket versioning enabled (R2 → bucket → Settings → Object versioning)
- [ ] Lifecycle rule: delete old versions after 30 days
- [ ] Public access enabled with custom domain or r2.dev URL
- [ ] CORS policy allows PUT from frontend origins

## Secrets Rotation

### JWT Secret
1. Generate new secret: `openssl rand -base64 64`
2. Set new `JWT_SECRET` in Vercel env vars
3. Redeploy — all existing tokens are immediately invalidated
4. Users must re-login (expected behavior)

### Stripe Secret Key
1. Generate new key in Stripe Dashboard → Developers → API Keys → Roll key
2. Update `STRIPE_SECRET_KEY` in Vercel
3. Redeploy
4. Old key is invalidated by Stripe after 24h grace period

### Stripe Webhook Secret
1. In Stripe Dashboard → Webhooks → endpoint → Roll secret
2. Update `STRIPE_WEBHOOK_SECRET` in Vercel
3. Redeploy immediately (old secret stops working)

### Paystack Secret Key
1. Regenerate in Paystack Dashboard → Settings → API Keys
2. Update `PAYSTACK_SECRET_KEY` in Vercel
3. Redeploy

## Admin Bootstrap

First admin user is created via the seed script or manually:

```bash
npx tsx prisma/seed.ts
```

Or set env vars before first deploy:
- `ADMIN_EMAIL=admin@yourdomain.com`
- `ADMIN_PASSWORD=<strong-password>`
- `ADMIN_NAME=Admin`

The `bootstrapAdmin()` function in `server.ts` creates the admin on startup (long-running mode only, not serverless).

## Rollback Procedure

1. **Identify the bad commit** in Vercel Deployments
2. **Instant rollback:** Vercel → Deployments → find last good deployment → "..." → Promote to Production
3. **Database rollback (if migration broke data):**
   - Create Neon branch from before the migration timestamp
   - Point `DATABASE_URL` to the branch
   - Fix the migration, re-deploy
4. **If Stripe/Paystack state is inconsistent:**
   - Run reconciliation scripts (see below)
   - Manually resolve in provider dashboard

## Environment Variables (Complete List)

| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | ✅ | Neon pooled connection string |
| JWT_SECRET | ✅ | Token signing key |
| STRIPE_SECRET_KEY | ✅ | Stripe API secret |
| STRIPE_WEBHOOK_SECRET | ✅ | Stripe webhook signing secret |
| PLATFORM_FEE_BPS | ✅ | Platform fee (1000 = 10%) |
| RESEND_API_KEY | ✅ | Email delivery |
| EMAIL_FROM | ✅ | Sender address |
| S3_BUCKET | ✅ | R2 bucket name |
| S3_ENDPOINT | ✅ | R2 endpoint URL |
| S3_ACCESS_KEY_ID | ✅ | R2 access key |
| S3_SECRET_ACCESS_KEY | ✅ | R2 secret key |
| S3_PUBLIC_URL | ✅ | R2 public URL |
| CORS_ORIGINS | ⚠️ | Comma-separated allowed origins |
| PUBLIC_STORE_BASE_URL | — | Default: https://neon.online |
| SENTRY_DSN | — | Error monitoring |
| PAYSTACK_SECRET_KEY | — | For Africa domestic escrow |
| SMS_API_KEY | — | Africa's Talking SMS |
| AT_USERNAME | — | Africa's Talking username |
| REDIS_URL | — | BullMQ background jobs |
| OPS_ALERT_EMAIL | — | Escrow balance alerts |

## Pre-Launch Verification

```bash
# Local
npx prisma generate
npx tsc --noEmit
npx vitest run

# Production
npm run launch:health
npm run reconcile:wallets
```
