# Queue & CDN Scaling Plan

## Current Ceiling
- Vercel serverless: 10s execution timeout (default), 30s max
- Synchronous webhook processing: must complete within timeout
- No background jobs without Redis (BullMQ workers only run in long-lived process)

## Why This Matters
- Webhook handlers that do heavy work (notifications, emails, reconciliation) can timeout
- Notification delivery is fire-and-forget but adds latency to the request
- Reconciliation scripts run locally, not on schedule

## Recommended Queue Options

### Option A: Inngest (Recommended for Vercel)
- Serverless-native, no Redis needed
- Event-driven: webhook fires event → Inngest runs function
- Built-in retry, rate limiting, scheduling
- Free tier: 25k events/month

### Option B: QStash (Upstash)
- HTTP-based message queue
- Works with Vercel serverless
- Scheduled messages (cron replacement)
- Free tier: 500 messages/day

### Option C: Postgres Job Table (Self-managed)
- Add a `Job` table with status, payload, scheduledAt
- Poll every N seconds from a worker process
- Simple but requires a long-running process (not Vercel)

## What to Move to Background Jobs
| Task | Current | Target | Priority |
|------|---------|--------|----------|
| Push notifications | Sync in request | Background | High |
| Email sending | Sync (Resend) | Background | Medium |
| Reconciliation | Manual script | Scheduled (daily) | Medium |
| Vendor payout notifications | Sync | Background | Low |
| Non-critical webhook side effects | Sync | Background | Low |

## Cloudflare CDN Cache Rules

### Cache (public, read-only)
```
GET /api/products         → s-maxage=60
GET /api/products/:id     → s-maxage=60
GET /api/delivery/zones   → s-maxage=300
GET /api/public/stores/*  → s-maxage=120
GET /openapi.json         → s-maxage=3600
```

### Bypass (authenticated/dynamic)
```
Authorization header present → bypass
/api/auth/*     → bypass
/api/admin/*    → bypass
/api/cart/*     → bypass
/api/orders/*   → bypass
/api/payments/* → bypass
/api/vendors/*  → bypass
```

## Rollout Plan
1. Add Inngest/QStash to project
2. Move notifications to background (lowest risk)
3. Move email sending to background
4. Add scheduled reconciliation (daily at 3am UTC)
5. Monitor: ensure no dropped events

## Rollback Plan
- If queue provider is down: fall back to synchronous (current behavior)
- Feature flag: `USE_BACKGROUND_JOBS=true/false`
- Sync fallback is always available in notification/email services
