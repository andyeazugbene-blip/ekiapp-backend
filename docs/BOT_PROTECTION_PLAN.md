# Bot Protection Plan

## Recommended: Cloudflare Turnstile
- Free, privacy-preserving CAPTCHA alternative
- Invisible challenge (no user friction)
- Site key (frontend) + secret key (backend)

## Backend Validation Flow
1. Frontend includes Turnstile widget on registration page
2. On submit, frontend sends `cf-turnstile-response` token in request body
3. Backend validates token with Cloudflare:
```
POST https://challenges.cloudflare.com/turnstile/v0/siteverify
Body: { secret, response, remoteip }
```
4. If invalid → reject with 403

## Apply To
- `POST /api/auth/register` — primary target (prevents mass account creation)
- `POST /api/auth/login` — optional (rate limiter already handles brute force)
- `POST /api/auth/forgot-password` — prevents email bombing

## Skip/Relax For
- Requests with valid admin JWT (internal testing)
- `NODE_ENV=development` or `NODE_ENV=test`
- Specific test account emails (configurable allowlist)

## Frontend Integration
```tsx
import { Turnstile } from "@marsidev/react-turnstile";

<Turnstile siteKey={TURNSTILE_SITE_KEY} onSuccess={setToken} />
```

## Env Vars
- `TURNSTILE_SECRET_KEY` — backend verification
- `EXPO_PUBLIC_TURNSTILE_SITE_KEY` — frontend widget
