# Cloudflare CDN & Cache Live Setup

## Status: EXTERNAL SETUP REQUIRED

## Cache Rules

### Cacheable Endpoints (Public, Read-Only)

| Endpoint | Cache TTL | Edge TTL | Notes |
|----------|-----------|----------|-------|
| `GET /api/products` | 60s | 300s | Product listings |
| `GET /api/products/:id` | 60s | 300s | Product detail |
| `GET /api/delivery/zones` | 300s | 600s | Delivery zones (rarely change) |
| `GET /api/public/stores/:slug` | 60s | 300s | Public store pages |
| `GET /store/:slug` | 60s | 300s | Server-rendered store page |

### Cache Bypass Rules (Never Cache)

| Pattern | Reason |
|---------|--------|
| `Authorization` header present | Authenticated requests |
| `GET /api/auth/*` | Auth endpoints |
| `GET /api/me/*` | User-specific data |
| `GET /api/cart/*` | User cart |
| `GET /api/orders/*` | User orders |
| `GET /api/payments/*` | Payment data |
| `GET /api/admin/*` | Admin panel |
| `GET /api/notifications/*` | User notifications |
| `GET /api/conversations/*` | Messages |
| `GET /api/wallet/*` | Wallet data |
| `POST/PATCH/DELETE *` | All mutations |

## Cloudflare Page Rules / Cache Rules Configuration

### Rule 1: Cache Product Listings
```
URL: your-domain.com/api/products*
Setting: Cache Level = Standard
Edge TTL: 5 minutes
Browser TTL: 1 minute
Bypass on: Authorization header present
```

### Rule 2: Cache Delivery Zones
```
URL: your-domain.com/api/delivery/zones*
Setting: Cache Level = Standard
Edge TTL: 10 minutes
Browser TTL: 5 minutes
Bypass on: Authorization header present
```

### Rule 3: Cache Public Store Pages
```
URL: your-domain.com/store/*
Setting: Cache Level = Standard
Edge TTL: 5 minutes
Browser TTL: 1 minute
```

### Rule 4: Bypass Auth & User Routes
```
URL: your-domain.com/api/auth/*
URL: your-domain.com/api/me/*
URL: your-domain.com/api/cart/*
URL: your-domain.com/api/orders/*
URL: your-domain.com/api/payments/*
URL: your-domain.com/api/admin/*
Setting: Cache Level = Bypass
```

## Cloudflare Transform Rules (Headers)

Add `Cache-Control` headers at the origin (already handled by Vercel for static assets):

```
# For cacheable API responses, add in Express if needed:
res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
```

## Security Settings

| Setting | Value | Notes |
|---------|-------|-------|
| SSL/TLS | Full (Strict) | End-to-end encryption |
| Always Use HTTPS | On | Redirect HTTP → HTTPS |
| Minimum TLS Version | 1.2 | Block TLS 1.0/1.1 |
| HSTS | On (max-age=31536000) | Strict Transport Security |
| WAF | On (Managed Rules) | Block common attacks |
| Bot Fight Mode | On | Basic bot protection |
| Rate Limiting | Custom rules | Supplement app-level rate limiting |

## DNS Configuration

| Record | Name | Value | Proxy |
|--------|------|-------|-------|
| CNAME | @ | cname.vercel-dns.com | ☁️ Proxied |
| CNAME | www | cname.vercel-dns.com | ☁️ Proxied |
| CNAME | status | statuspage-cname | ☁️ Proxied |

## Setup Steps

1. [ ] Add domain to Cloudflare
2. [ ] Update nameservers at registrar
3. [ ] Configure SSL/TLS to "Full (Strict)"
4. [ ] Create cache rules (as above)
5. [ ] Enable WAF managed rules
6. [ ] Enable Bot Fight Mode
7. [ ] Configure rate limiting rules
8. [ ] Test: verify cached responses have `cf-cache-status: HIT`
9. [ ] Test: verify auth routes are not cached
10. [ ] Monitor cache hit ratio in Cloudflare Analytics
