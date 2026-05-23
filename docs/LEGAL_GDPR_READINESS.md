# Legal & GDPR Readiness

## Status: BACKEND COMPLETE / LEGAL DOCUMENTS EXTERNAL SETUP REQUIRED

## Backend Endpoints (Implemented)

| Endpoint | Method | Status | Description |
|----------|--------|--------|-------------|
| `/api/me/data-export` | GET | ✅ LIVE | GDPR Art. 20 — Data portability |
| `/api/me/delete-account` | POST | ✅ LIVE | GDPR Art. 17 — Right to erasure |

### Data Export (`GET /api/me/data-export`)
- Returns all personal data: profile, orders, notifications
- Authenticated users only
- JSON format for machine-readability

### Account Deletion (`POST /api/me/delete-account`)
- Anonymizes user data (email, name, phone, avatar)
- Retains financial records for legal compliance (orders, payments)
- Invalidates all tokens (tokenVersion increment)
- Blocks deletion if pending orders exist
- Deletes notifications and push tokens

## Legal Documents Required

| Document | Status | Notes |
|----------|--------|-------|
| Terms of Service | ❌ NOT CREATED | Must cover: marketplace rules, liability, dispute resolution, refund policy |
| Privacy Policy | ❌ NOT CREATED | Must cover: data collected, processing purposes, retention, rights, subprocessors |
| Cookie Policy / Banner | ❌ NOT CREATED | Required for EU users; must cover analytics, session cookies |
| Acceptable Use Policy | ❌ NOT CREATED | Vendor content rules, prohibited items |

## Subprocessors (Data Processing)

| Subprocessor | Purpose | Data Processed | Location |
|--------------|---------|----------------|----------|
| Vercel | Hosting, serverless functions | All request data, logs | US/EU (configurable) |
| Neon | PostgreSQL database | All user/order/payment data | US/EU |
| Stripe | International payments | Email, payment details, order amounts | US/EU |
| Paystack | Africa domestic payments | Email, payment details, bank info | Nigeria |
| Cloudflare R2 | File storage (product images) | Uploaded files, metadata | Global |
| Sentry | Error monitoring | Error context, user IDs, request paths | US |
| Resend | Transactional email | Email addresses, email content | US |

## GDPR Compliance Checklist

### Technical Measures (Done)
- [x] Data export endpoint
- [x] Account deletion/anonymization endpoint
- [x] Password hashing (bcrypt, 12 rounds)
- [x] JWT token revocation capability
- [x] Account lockout after failed attempts
- [x] Email verification flow
- [x] Structured logging (no PII in logs)
- [x] HTTPS enforced (Vercel)

### Organizational Measures (Required)
- [ ] Privacy Policy published on website
- [ ] Terms of Service published on website
- [ ] Cookie consent banner implemented (frontend)
- [ ] Data Processing Agreements (DPAs) with subprocessors
- [ ] Data retention policy documented
- [ ] Breach notification procedure documented
- [ ] Data Protection Officer (DPO) designated (if >250 employees or large-scale processing)

## User Consent

The backend does NOT currently enforce `acceptedTosVersion` on the User model. This is intentional:
- ToS acceptance is typically handled at the frontend/registration flow level
- The backend can be extended to add a `tosAcceptedAt` / `tosVersion` field if needed
- Recommendation: Add ToS acceptance checkbox on registration, store timestamp

## Action Items for Legal Team

1. Draft Terms of Service (cover marketplace, escrow, refunds, disputes)
2. Draft Privacy Policy (GDPR-compliant, list all subprocessors above)
3. Implement cookie consent banner on frontend
4. Sign DPAs with: Vercel, Neon, Stripe, Paystack, Cloudflare, Sentry, Resend
5. Define data retention periods (suggest: 7 years for financial, 2 years for logs)
