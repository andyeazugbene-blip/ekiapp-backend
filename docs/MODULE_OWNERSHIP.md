# Module Ownership Map

| Module | Domain | Critical? | Notes |
|--------|--------|-----------|-------|
| `auth` | Identity | Yes | JWT, OTP, password, lockout |
| `payments` | Money | Yes | Stripe checkout, wallet deduction |
| `stripe` | Money | Yes | Webhook handler, refund reversal |
| `paystack` | Money | Yes | Escrow, disputes, trust score, bank accounts |
| `orders` | Commerce | Yes | Order lifecycle, status transitions |
| `buyer-wallet` | Money | Yes | Top-up, apply, ledger |
| `payouts` | Money | Yes | Vendor payout requests |
| `vendors` | Commerce | Yes | Profile, dashboard, earnings, buyers |
| `products` | Commerce | No | CRUD, stock, currency inheritance |
| `cart` | Commerce | No | Add/remove/clear |
| `delivery` | Commerce | No | Zone calculation |
| `admin` | Operations | Yes | Moderation, refunds, disputes |
| `uploads` | Infrastructure | No | R2 presigned URLs |
| `referrals` | Growth | No | Bonus on first order |
| `promos` | Growth | No | Promo code redemption |
| `reviews` | Trust | No | Rating, moderation |
| `subscriptions` | Monetization | No | Plan activation, limits |
| `notifications` | Communication | No | Push, in-app |
| `messages` | Communication | No | Buyer-vendor chat |
| `public-stores` | Discovery | No | Public storefront pages |
| `push-tokens` | Communication | No | Expo push token storage |
| `addresses` | Commerce | No | Buyer delivery addresses |
| `shipments` | Logistics | No | Tracking |
| `verification` | Trust | No | KYC documents |

## Money-Adjacent Modules (require extra review)
- payments, stripe, paystack, buyer-wallet, payouts, orders, subscriptions, referrals, promos
