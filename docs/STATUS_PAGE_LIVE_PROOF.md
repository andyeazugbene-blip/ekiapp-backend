# Status Page Live Proof

## Status: EXTERNAL SETUP REQUIRED

## Recommended Provider: BetterStack (BetterUptime)

BetterStack provides a hosted status page with uptime monitoring, incident management, and integrations.

## Components to Monitor

| Component | Health URL | Check Interval | Threshold |
|-----------|-----------|----------------|-----------|
| API | `GET /api/health` | 30s | 2 failures |
| Database | `GET /api/health/detailed` → `checks.database.status` | 60s | 1 failure |
| Stripe | `GET /api/health/detailed` → `checks.stripe.status` | 60s | 2 failures |
| Paystack | `GET /api/health/detailed` → `checks.paystack.status` | 60s | 2 failures |
| R2 Uploads | Custom check (presigned URL generation) | 300s | 3 failures |
| Email/OTP | Synthetic test (send test email) | 300s | 3 failures |

## Health Endpoint

**URL**: `GET /api/health/detailed`

**Response** (200 OK):
```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latencyMs": 12 },
    "stripe": { "status": "ok", "latencyMs": 230 },
    "paystack": { "status": "ok", "latencyMs": 180 }
  }
}
```

**Response** (503 Degraded):
```json
{
  "status": "degraded",
  "checks": {
    "database": { "status": "error", "latencyMs": 5000, "detail": "Connection timeout" },
    "stripe": { "status": "ok", "latencyMs": 200 },
    "paystack": { "status": "skipped", "detail": "Not configured" }
  }
}
```

## Setup Steps (BetterStack)

1. Sign up at [betterstack.com](https://betterstack.com)
2. Create monitors:
   - **API Health**: `GET https://your-domain.com/api/health` → expect 200
   - **Detailed Health**: `GET https://your-domain.com/api/health/detailed` → expect 200
3. Create status page:
   - Custom domain: `status.your-domain.com`
   - Add all components listed above
4. Configure incident notifications:
   - Email: ops team
   - Slack: `#incidents`
   - PagerDuty: on-call rotation (if applicable)
5. Add status page link to:
   - App footer
   - Support page
   - Email signatures

## Alternative: Vercel Status + Custom

If using Vercel's built-in monitoring:
1. Vercel Dashboard → Project → Analytics → Enable
2. Set up Vercel Checks for deployment health
3. Note: Vercel does not provide a public-facing status page — use BetterStack or Atlassian Statuspage for that.

## Verification Checklist

- [ ] Status page URL is live and accessible
- [ ] All 6 components are listed
- [ ] Health check monitors are active
- [ ] Incident notification channels configured
- [ ] Status page linked from app/support
