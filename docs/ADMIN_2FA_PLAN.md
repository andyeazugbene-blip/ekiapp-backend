# Admin 2FA Plan

## Overview
TOTP-based two-factor authentication for admin accounts using `otplib`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/2fa/setup` | Generate TOTP secret + QR code URI |
| POST | `/api/admin/2fa/verify` | Verify TOTP code and enable 2FA |
| POST | `/api/admin/2fa/disable` | Disable 2FA (requires current TOTP) |
| POST | `/api/admin/2fa/backup-codes/regenerate` | Generate new backup codes |

## Data Model
```prisma
model AdminTwoFactor {
  id          String   @id @default(cuid())
  userId      String   @unique
  secret      String   // encrypted TOTP secret
  enabled     Boolean  @default(false)
  backupCodes String[] // hashed backup codes
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

## Flow
1. Admin calls `/2fa/setup` → receives `otpauthUrl` (for QR code) + `secret`
2. Admin scans QR in authenticator app (Google Authenticator, Authy)
3. Admin enters 6-digit code → calls `/2fa/verify` → 2FA enabled
4. On subsequent sensitive actions, middleware checks `x-2fa-code` header

## Enforcement
- Required for: refunds, vendor suspend/unsuspend, payout mark-paid
- Not required for: read-only admin endpoints (listings, dashboard)

## Implementation Notes
- Use `otplib` package (already well-maintained)
- Store secret encrypted with a server-side key
- Backup codes: 10 single-use codes, bcrypt-hashed
- Grace period: 30 seconds (1 window before + after)
