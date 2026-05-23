# Status Page Setup

## Recommended Tools (Free Tier)
- **BetterStack Status** (betteruptime.com) — free for 5 monitors
- **Instatus** (instatus.com) — free tier available
- **Atlassian Statuspage** — free for small teams

## Components to Monitor
| Component | Health Check URL | Interval |
|-----------|-----------------|----------|
| API | https://italian-market-place.vercel.app/api/health | 60s |
| Database | https://italian-market-place.vercel.app/api/health/detailed | 300s |
| Stripe Payments | (via /api/health/detailed checks.stripe) | 300s |
| Paystack Payments | (via /api/health/detailed checks.paystack) | 300s |
| R2 Uploads | Manual or synthetic upload test | 900s |
| Email/OTP | Manual or Resend dashboard | — |

## Alert Rules
- **Incident trigger:** 2 consecutive failures on any critical component
- **Critical components:** API, Database, Stripe
- **Non-critical:** Paystack (only affects Africa domestic), R2 (degrades uploads only)

## Setup Steps
1. Create account on chosen provider
2. Add monitor: `GET https://italian-market-place.vercel.app/api/health/detailed`
3. Expected response: HTTP 200, body contains `"status":"ok"`
4. Alert channels: email + Slack/Discord
5. Public status page URL: share with vendors and buyers
