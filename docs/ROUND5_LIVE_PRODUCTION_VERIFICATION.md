# Round 5 — Live Production Verification

**Generated**: 2026-05-24
**Target**: https://italian-market-place.vercel.app
**Deploy**: commit `ec57fd4` (Round 5 code) — confirmed live

---

## Final Verdict: ✅ **LIVE PRODUCTION READY**

| Layer | Result |
|---|---|
| Code (Round 5 deployed) | ✅ verified by live response shape |
| Turnstile mode | ✅ **DISABLED TEMPORARILY** (`TURNSTILE_DISABLED=true`) |
| Live registration | ✅ 201 Created, no `TURNSTILE_NOT_CONFIGURED` |
| R2 live round-trip | ✅ presign + PUT 200 + GET 200 image/png |
| `launch:health` | ✅ 10/10 |
| `reconcile:wallets` | ✅ 0 mismatches (56 vendor + 16 buyer wallets) |
| `reconcile:stripe` | ✅ 0 mismatches |
| `reconcile:paystack` | ✅ skipped (intentional — `PAYSTACK_SECRET_KEY` unset) |
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run` | ✅ 315/315 passing (26 files) |

---

## Task 1 — Turnstile Live Config

### Mode: **DISABLED TEMPORARILY**

The operator set `TURNSTILE_DISABLED=true` in Vercel production environment variables. This is the intentional temporary launch posture documented in `docs/BOT_PROTECTION_PLAN.md` — registration is allowed without a Turnstile token while the frontend Turnstile widget is being wired up. To enable enforcement later: unset `TURNSTILE_DISABLED`, set `TURNSTILE_SECRET_KEY=<real Cloudflare secret>`, and redeploy.

### Live registration proof

Run: `npx tsx scripts/round5-live-probe.ts https://italian-market-place.vercel.app`

```text
[register: no token] POST https://italian-market-place.vercel.app/api/auth/register
  body: { email, password, name }                  // no cf-turnstile-response
  status: 201
  body: {"user":{"id":"cmpjtbjdd0000jj04sdp9xg8r","email":"live-probe-1779629272431@example.com",
         "name":"Live Probe","role":"BUYER","trustScore":50,...},
         "token":"eyJhbGciOiJIUzI1NiIsInR5cCI6Ikp..."}

[register: bogus token] POST https://italian-market-place.vercel.app/api/auth/register
  body: { email, password, name, "cf-turnstile-response":"bogus-token-from-round5-probe" }
  status: 201
  body: {"user":{...},"token":"..."}
```

Both attempts produced 201 + a real BUYER user + a JWT. No `TURNSTILE_NOT_CONFIGURED`. Confirms `TURNSTILE_DISABLED=true` is in effect.

### `npm run register:smoke` confirmation

```text
> tsx scripts/register-smoke.ts https://italian-market-place.vercel.app
Production register smoke test
  base: https://italian-market-place.vercel.app

[1/2] POST /api/auth/register without cf-turnstile-response...
  Server has TURNSTILE_DISABLED=true. Skipping token tests.
exit 0
```

Status: ✅ **PASS**

---

## Task 2 — R2 Live Round-Trip

### Result: ✅ **PASS**

```text
> npm run r2:round-trip https://italian-market-place.vercel.app <vendor-jwt>

R2 round-trip smoke test
  base: https://italian-market-place.vercel.app

[1/3] Requesting presigned upload URL...
  OK: {
    key: 'product/cmozxj4x30001ufd0430o4719/1779629420713-ed8c20f42b80c5f9.png',
    publicUrl: 'https://pub-6e1f7bd9b8c4416c98d78db307a2f93b.r2.dev/product/cmozxj4x30001ufd0430o4719/1779629420713-ed8c20f42b80c5f9.png'
  }

[2/3] PUT 1x1 PNG to presigned URL...
  OK: PUT 200

[3/3] GET publicUrl...
  OK: GET 200, content-type: image/png

✅ R2 round-trip PASS
```

### Per-step result table

| Step | Endpoint | Expected | Actual | PASS? |
|---|---|---|---|---|
| 1 | `POST /api/uploads/request-url` | 200 + `{ uploadUrl, publicUrl, key }` | 200, R2 host returned | ✅ |
| 2 | `PUT <uploadUrl>` (1×1 PNG) | 200 or 204 | 200 | ✅ |
| 3 | `GET <publicUrl>` | 200, `image/png` | 200, `image/png` | ✅ |
| - | No `SignatureDoesNotMatch` | clear | clear | ✅ |
| - | No 503 storage error | clear | clear | ✅ |

`publicUrl` host is `pub-6e1f7bd9b8c4416c98d78db307a2f93b.r2.dev` — Cloudflare R2's public bucket URL — confirming `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_PUBLIC_URL` are all correctly set in Vercel.

---

## Task 3 — Production Smoke

### `npm run launch:health`

```text
=== LAUNCH HEALTH CHECK ===
Target: https://italian-market-place.vercel.app

✅ GET /api/health — 200
✅ GET /api/health/detailed — status=ok
✅ Database connectivity — ok
✅ Stripe connectivity — ok
✅ OpenAPI spec — 200
✅ Auth guard (no token → 401) — 401
✅ Products endpoint — 200
✅ Upload endpoint (401 without auth) — 401
✅ Stripe webhook (400 bad sig) — 400
✅ Paystack webhook (400 bad sig) — 400

=== RESULTS: ✅ 10 | ❌ 0 ===
✅ ALL SYSTEMS OPERATIONAL
```

### `/api/health/detailed`

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latencyMs": 668 },
    "stripe":   { "status": "ok", "latencyMs": 217 },
    "paystack": { "status": "skipped", "detail": "PAYSTACK_SECRET_KEY not configured" }
  }
}
```

### `npm run reconcile:wallets`

```text
Vendor wallets checked: 56
Buyer wallets checked: 16
Mismatches: 0
PASS — All wallets reconcile
```

### `npm run reconcile:stripe`

```text
Stripe PaymentIntents (last 24h): 1
Checked: 1 Stripe PIs, 1 DB checkouts
Mismatches: 0
PASS — Stripe reconciles
```

### `npm run reconcile:paystack`

```text
PAYSTACK_SECRET_KEY not configured. Skipping.
PASS (skipped — no Paystack)
```

Brief explicitly accepts this: *"Paystack reconciliation either PASS or PASS skipped if PAYSTACK_SECRET_KEY intentionally not configured"*.

---

## Task 4 — TypeScript / Vitest

```text
> npx tsc --noEmit
TSC_EXIT=0

> npx vitest run
 Test Files  26 passed (26)
      Tests  315 passed (315)
   Duration  ~12.9s
exit 0
```

---

## Reproduction commands

```bash
# Live probe (confirms current Turnstile mode and DB/Stripe health)
npx tsx scripts/round5-live-probe.ts https://italian-market-place.vercel.app

# Register smoke
npm run register:smoke https://italian-market-place.vercel.app

# Health + reconciliations
npm run launch:health
npm run reconcile:wallets
npm run reconcile:stripe
npm run reconcile:paystack

# R2 round-trip (auto-detects vendor seed credentials)
npx tsx scripts/round5-r2-attempt.ts https://italian-market-place.vercel.app
# copy the printed token, then:
npm run r2:round-trip https://italian-market-place.vercel.app <token>

# Local CI
npx tsc --noEmit
npx vitest run
```

---

## Verdict: ✅ **LIVE PRODUCTION READY**

All gating criteria are met:
- ✅ Registration no longer returns Turnstile 503 — operator chose `TURNSTILE_DISABLED=true` (temporary, documented).
- ✅ R2 round-trip passes end-to-end against the live deployment.
- ✅ Health check passes 10/10.
- ✅ All tests pass (315/315), tsc clean.
- ✅ Reconciliations clean (or intentionally skipped).

### Re-enabling Turnstile later

When the frontend ships with the `<Turnstile>` widget that injects `cf-turnstile-response`, ops should:
1. Set `TURNSTILE_SECRET_KEY=<Cloudflare Turnstile secret>` in Vercel production.
2. Unset (or set to anything other than `true`) `TURNSTILE_DISABLED`.
3. Redeploy.
4. Run `npm run register:smoke https://italian-market-place.vercel.app` — expect:
   - `[1/2] no token → status=400 code=TURNSTILE_TOKEN_MISSING`
   - `[2/2] bogus token → status=403 code=TURNSTILE_INVALID_TOKEN`
