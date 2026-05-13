# Staging Deployment Checklist

---

## 1. Required Environment Variables

Set ALL of these in your hosting platform (Vercel, Railway, etc.):

### Critical (app won't start without these)
```
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://USER:PASS@host/db?sslmode=require&pgbouncer=true&connection_limit=1
STRIPE_SECRET_KEY=sk_live_... (or sk_test_... for staging)
STRIPE_WEBHOOK_SECRET=whsec_...
JWT_SECRET=<random 64+ char string — generate with: openssl rand -hex 32>
```

### Required for full functionality
```
CORS_ORIGINS=https://your-frontend.vercel.app,https://your-admin.vercel.app
REDIS_URL=redis://default:PASS@host:6379
RESEND_API_KEY=re_...
EMAIL_FROM=Eki Marketplace <noreply@yourdomain.com>
FRONTEND_URL=https://your-frontend.vercel.app
```

### File storage (S3/Cloudflare R2)
```
S3_BUCKET=eki-uploads-staging
S3_REGION=auto
S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_URL=https://cdn.yourdomain.com
```

### Optional
```
SENTRY_DSN=https://...@sentry.io/...
LOG_LEVEL=info
JWT_EXPIRES_IN=7d
DEFAULT_CURRENCY=usd
PLATFORM_FEE_BPS=1000
```

### First-boot only (remove after first admin is created)
```
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=<min 12 chars, strong>
ADMIN_NAME=Admin
```

---

## 2. Prisma Migration Steps

### First deployment (fresh database)
```bash
# Generate client
npx prisma generate

# Apply all migrations
npx prisma migrate deploy

# Seed (optional, staging only)
npx prisma db seed
```

### Subsequent deployments
```bash
npx prisma generate
npx prisma migrate deploy
```

### Verify migration status
```bash
npx prisma migrate status
```

### If migration fails
```bash
# Check which migration failed
npx prisma migrate status

# Mark as rolled back if needed
npx prisma migrate resolve --rolled-back <migration_name>

# Or mark as applied if it was partially applied
npx prisma migrate resolve --applied <migration_name>
```

---

## 3. Stripe Webhook Setup

### Create webhook endpoint in Stripe Dashboard

1. Go to https://dashboard.stripe.com/webhooks
2. Click "Add endpoint"
3. URL: `https://your-api.vercel.app/api/stripe/webhook`
4. Select events:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `account.updated` (for Stripe Connect)
5. Copy the signing secret → set as `STRIPE_WEBHOOK_SECRET`

### Verify webhook is working
```bash
# Use Stripe CLI for local testing
stripe listen --forward-to localhost:4000/api/stripe/webhook

# Trigger a test event
stripe trigger payment_intent.succeeded
```

### Stripe Connect (if using)
- Enable Connect in Stripe Dashboard
- Set platform country and business type
- Webhook events for Connect are received on the same endpoint

---

## 4. Resend Email Setup

1. Create account at https://resend.com
2. Add and verify your sending domain (DNS records)
3. Create API key → set as `RESEND_API_KEY`
4. Set `EMAIL_FROM` to match your verified domain: `Eki Marketplace <noreply@yourdomain.com>`

### Verify
- Register a test user → should receive welcome email
- Trigger forgot-password → should receive reset email

### If emails aren't sending
- Check Resend dashboard for delivery logs
- Verify domain DNS records (SPF, DKIM, DMARC)
- Check `EMAIL_FROM` matches verified domain

---

## 5. S3/Cloudflare R2 Setup

### Cloudflare R2 (recommended)
1. Create R2 bucket in Cloudflare dashboard (e.g., `eki-uploads-staging`)
2. Create R2 API token with Object Read & Write permissions
3. Note your Account ID from the dashboard URL
4. Set env vars:
   ```
   S3_BUCKET=eki-uploads-staging
   S3_REGION=auto
   S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   S3_ACCESS_KEY_ID=<R2 access key>
   S3_SECRET_ACCESS_KEY=<R2 secret key>
   S3_PUBLIC_URL=https://cdn.yourdomain.com
   ```
5. Configure public access or Cloudflare CDN for the bucket

### CORS on bucket (required for browser uploads)
Add CORS policy to the bucket:
```json
[
  {
    "AllowedOrigins": ["https://your-frontend.vercel.app"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

### Verify
- Call `POST /api/uploads/request-url` → should return presigned URL
- Upload a file to the presigned URL → should be accessible at `publicUrl`

---

## 6. Worker Hosting Setup

Workers (notifications, emails, stock alerts, cart cleanup) require a **long-running process** — they cannot run on Vercel serverless.

### Option A: Railway (recommended for MVP)
1. Create a new Railway service from the same repo
2. Set start command: `npm start`
3. Set all the same env vars as the API
4. Workers start automatically with the server

### Option B: Separate worker process
1. Create `src/worker-entry.ts`:
   ```typescript
   import "./lib/sentry";
   import { logger } from "./lib/logger";
   import { startWorkers } from "./workers";
   startWorkers();
   logger.info("Worker process started");
   ```
2. Deploy as a separate service with command: `tsx src/worker-entry.ts`
3. Same env vars, same Redis URL

### Option C: Vercel + external worker
- API on Vercel (serverless, no workers)
- Workers on Railway/Render/Fly.io (long-running)
- Both share the same `DATABASE_URL` and `REDIS_URL`

### Redis requirement
- Workers need `REDIS_URL` to function
- Recommended: Upstash Redis (serverless-friendly) or Railway Redis
- Without Redis: workers are skipped, notifications/emails fall back to direct insert/send

---

## 7. Frontend API Base URL Setup

In your Expo/React Native frontend, set the API base URL:

### Development
```
API_BASE_URL=http://localhost:4000/api
```

### Staging
```
API_BASE_URL=https://your-api-staging.vercel.app/api
```

### Production
```
API_BASE_URL=https://api.yourdomain.com/api
```

### Frontend auth token storage
- Store JWT in `expo-secure-store` (not AsyncStorage)
- Attach to every request: `Authorization: Bearer <token>`
- On 401 response → redirect to login screen
- On 423 response → show "account locked" message

---

## 8. Smoke Test Checklist

Run these manually after deployment to verify core flows:

### Health
```bash
curl https://your-api.vercel.app/api/health
# Expected: { "status": "ok" }
```

### Auth
```bash
# Register
curl -X POST https://your-api.vercel.app/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123","name":"Test User"}'
# Expected: 201 { user, token }

# Login
curl -X POST https://your-api.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123"}'
# Expected: 200 { user, token }

# Me (use token from above)
curl https://your-api.vercel.app/api/auth/me \
  -H "Authorization: Bearer <token>"
# Expected: 200 { user }
```

### CORS
```bash
curl -I -X OPTIONS https://your-api.vercel.app/api/health \
  -H "Origin: https://evil-site.com"
# Expected: No Access-Control-Allow-Origin header (blocked)

curl -I -X OPTIONS https://your-api.vercel.app/api/health \
  -H "Origin: https://your-frontend.vercel.app"
# Expected: Access-Control-Allow-Origin: https://your-frontend.vercel.app
```

### Rate limiting
```bash
# Hit auth endpoint 11 times rapidly
for i in {1..11}; do curl -s -o /dev/null -w "%{http_code}\n" -X POST https://your-api.vercel.app/api/auth/login -H "Content-Type: application/json" -d '{"email":"x","password":"x"}'; done
# Expected: first 10 return 401, 11th returns 429
```

### Swagger (should NOT be accessible)
```bash
curl https://your-api.vercel.app/api/docs
# Expected: 404 (not found in production)
```

### Products (public)
```bash
curl https://your-api.vercel.app/api/products
# Expected: 200 { items: [], nextCursor: null }
```

### Webhook signature
```bash
curl -X POST https://your-api.vercel.app/api/stripe/webhook \
  -H "Content-Type: application/json" \
  -d '{"fake":"data"}'
# Expected: 400 (invalid signature)
```

### Admin bootstrap
```bash
# Login with ADMIN_EMAIL/ADMIN_PASSWORD
curl -X POST https://your-api.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourdomain.com","password":"<ADMIN_PASSWORD>"}'
# Expected: 200 { user: { role: "ADMIN" }, token }
```

---

## 9. Rollback Plan

### If deployment fails

**Vercel:**
- Go to Vercel dashboard → Deployments
- Click "..." on the previous working deployment → "Promote to Production"
- Instant rollback, no downtime

**Railway:**
- Go to Railway dashboard → Deployments
- Click "Rollback" on the previous deployment

### If migration fails

```bash
# 1. Check status
npx prisma migrate status

# 2. If the migration partially applied, mark it as rolled back
npx prisma migrate resolve --rolled-back <migration_name>

# 3. Redeploy the previous code version (which doesn't expect the new schema)

# 4. Fix the migration locally, test, redeploy
```

### If data corruption occurs

```bash
# 1. Stop the API immediately (scale to 0 or disable)
# 2. Take a database snapshot/backup
# 3. Investigate using Prisma Studio:
npx prisma studio
# 4. Fix data manually or restore from backup
# 5. Redeploy
```

### Emergency contacts
- Stripe issues: https://support.stripe.com
- Neon DB issues: https://neon.tech/docs/support
- Vercel issues: https://vercel.com/support
- Resend issues: https://resend.com/support

---

## 10. Post-Deployment

After successful staging deployment:

1. ✅ Remove `ADMIN_EMAIL`/`ADMIN_PASSWORD` from env vars (admin already created)
2. ✅ Verify Stripe webhook is receiving events (check Stripe dashboard)
3. ✅ Verify emails are being delivered (check Resend dashboard)
4. ✅ Run a full checkout flow (cart → payment → webhook → order PAID)
5. ✅ Verify file uploads work (presigned URL → upload → accessible)
6. ✅ Monitor error rates in Sentry for 24h
7. ✅ Share staging URL with frontend team for integration testing
