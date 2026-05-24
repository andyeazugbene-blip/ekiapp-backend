# Round 5 — Live Production Verification

**Generated**: 2026-05-24
**Target**: https://italian-market-place.vercel.app
**Deploy**: commit `ec57fd4` (Round 5 code) — confirmed live (see proof below)

---

## Executive Summary

| Task | Result |
|---|---|
| 1. Turnstile live config | **NOT CONFIGURED** — operator must set `TURNSTILE_SECRET_KEY` or `TURNSTILE_DISABLED=true` in Vercel |
| 2. R2 live round-trip | **PASS** — presign + PUT + GET all 200, content-type image/png |
| 3. Production smoke (health + reconciliations + tests) | **PASS** — 10/10 health checks, all reconciliations clean |
| 4. TypeScript / Vitest | **PASS** — tsc 0 errors, 315/315 tests |

**Final verdict**: **NOT READY** — single remaining blocker: Turnstile env var. The code is correct and the response is the explicit, controlled `503 TURNSTILE_NOT_CONFIGURED` we designed for this state, not a generic 503. Flipping one env var unblocks live registration.

---

## Task 1 — Turnstile Live Config

### Frontend status
The repository contains backend code only. The brief asked us to determine whether the frontend is sending `cf-turnstile-response`. Without the frontend source in this workspace I cannot inspect what it sends, but the production registration probe shows the backend never receives a valid token from any client today (it returns `TURNSTILE_NOT_CONFIGURED` before token validation runs because the secret is also missing). Operator must decide:

- **If frontend is NOT yet sending the token** → set `TURNSTILE_DISABLED=true` and redeploy.
- **If frontend IS sending the token** → set `TURNSTILE_SECRET_KEY=<real Cloudflare secret>` and redeploy.

### Live proof — current state

Run: `npx tsx scripts/round5-live-probe.ts https://italian-market-place.vercel.app`

```text
[register: no token] POST https://italian-market-place.vercel.app/api/auth/register
  status: 503
  body: {"message":"Captcha is not configured on the server. Set TURNSTILE_SECRET_KEY or TURNSTILE_DISABLED=true.","code":"TURNSTILE_NOT_CONFIGURED","details":null}

[register: bogus token] POST https://italian-market-place.vercel.app/api/auth/register
  body: {"cf-turnstile-response":"bogus-token-from-round5-probe", ...}
  status: 503
  body: {"message":"Captcha is not configured on the server. ...","code":"TURNSTILE_NOT_CONFIGURED","details":null}
```

This is **the new Round 5 controlled error**, not the old generic 503:
- Old (Round 4): `{"message":"Server misconfiguration: captcha not available","details":null}` — no `code` field.
- New (Round 5, deployed): `{"message":"Captcha is not configured on the server. Set TURNSTILE_SECRET_KEY or TURNSTILE_DISABLED=true.","code":"TURNSTILE_NOT_CONFIGURED",...}`

Confirms Round 5 commit `ec57fd4` is deployed.

### Required Vercel env var (one of)

| Var | Value | When |
|---|---|---|
| `TURNSTILE_DISABLED` | `true` | Frontend not yet sending `cf-turnstile-response` |
| `TURNSTILE_SECRET_KEY` | `<Cloudflare Turnstile secret>` | Frontend is sending the token |

Set the chosen var in **Vercel → Project → Settings → Environment Variables → Production** and redeploy.

### Status: **PENDING OPERATOR**

---

## Task 2 — R2 Live Round-Trip

### Result: **PASS**

```text
> npm run r2:round-trip https://italian-market-place.vercel.app <vendor-jwt>

R2 round-trip smoke test
  base: https://italian-market-place.vercel.app

[1/3] Requesting presigned upload URL...
  OK: {
    key: 'product/cmozxj4x30001ufd0430o4719/1779628124674-459285d35164c968.png',
    publicUrl: 'https://pub-6e1f7bd9b8c4416c98d78db307a2f93b.r2.dev/product/cmozxj4x30001ufd0430o4719/1779628124674-459285d35164c968.png'
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

The `publicUrl` host is `pub-*.r2.dev`, which is Cloudflare R2's default public bucket URL — this confirms R2 is wired through with valid credentials and `S3_PUBLIC_URL` is set.

---

## Task 3 — Quick Production Smoke

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

The brief explicitly accepts this: *"Paystack reconciliation either PASS or PASS skipped if PAYSTACK_SECRET_KEY intentionally not configured"*.

### `npm run register:smoke https://italian-market-place.vercel.app`

```text
[1/2] POST /api/auth/register without cf-turnstile-response...
  Server returned controlled 503 TURNSTILE_NOT_CONFIGURED.
  Set TURNSTILE_SECRET_KEY or TURNSTILE_DISABLED=true.
```

The smoke script correctly detects the operator action needed and surfaces it. This is the *expected* output for the current env state — it is **not** a generic 503; it is the controlled, machine-readable error designed for exactly this moment.

### `/api/health/detailed` raw

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latencyMs": 117 },
    "stripe":   { "status": "ok", "latencyMs": 208 },
    "paystack": { "status": "skipped", "detail": "PAYSTACK_SECRET_KEY not configured" }
  }
}
```

---

## Task 4 — TypeScript / Vitest

### `npx tsc --noEmit`

```text
(no output)
exit 0
```

### `npx vitest run`

```text
Test Files  26 passed (26)
     Tests  315 passed (315)
  Duration  ~13.7s
exit 0
```

---

## Final Verdict

| Layer | Status |
|---|---|
| Code | ✅ Round 5 commits `755a09f` + `ec57fd4` deployed to production (verified by inspecting the live error shape) |
| Tests | ✅ 315/315 passing, tsc clean |
| Health | ✅ 10/10, DB + Stripe ok, Paystack intentionally skipped |
| Reconciliations | ✅ Wallets clean, Stripe clean, Paystack skipped (intentional) |
| R2 upload pipeline | ✅ End-to-end round-trip PASS in production |
| Live registration | ❌ Returns `503 TURNSTILE_NOT_CONFIGURED` until operator sets the env var |

### Verdict: **NOT READY**

### Single remaining blocker

**Turnstile env var not set in Vercel production.**

Pick exactly one and redeploy:

| Action | Vercel env var | Set to | When |
|---|---|---|---|
| Disable Turnstile temporarily | `TURNSTILE_DISABLED` | `true` | Frontend not yet sending `cf-turnstile-response` |
| Enable Turnstile | `TURNSTILE_SECRET_KEY` | `<real Cloudflare secret from dashboard>` | Frontend already sending the token |

After redeploy, re-run:

```bash
npm run register:smoke https://italian-market-place.vercel.app
```

Expected after the flip:
- **`TURNSTILE_DISABLED=true`** → register returns 201 (or 409 duplicate / 400 validation), never `TURNSTILE_NOT_CONFIGURED`.
- **`TURNSTILE_SECRET_KEY=<secret>`** → register without token returns `400 TURNSTILE_TOKEN_MISSING`; with bogus token returns `403 TURNSTILE_INVALID_TOKEN`; with a valid frontend token returns 201.

When that single check passes, the verdict flips to **LIVE PRODUCTION READY**.

---

## Reproduction commands (for the next run)

```bash
# After flipping the Turnstile env var in Vercel and redeploying:
npm run register:smoke https://italian-market-place.vercel.app
npm run launch:health
npm run reconcile:wallets
npm run reconcile:stripe
npm run reconcile:paystack
npx tsc --noEmit
npx vitest run

# To re-prove R2 (requires a vendor JWT):
npx tsx scripts/round5-r2-attempt.ts https://italian-market-place.vercel.app
# copy the printed token, then:
npm run r2:round-trip https://italian-market-place.vercel.app <token>
```
