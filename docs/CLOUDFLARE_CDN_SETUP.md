# Cloudflare CDN Setup

## DNS Setup
1. Add domain (neon.online) to Cloudflare
2. Point A/CNAME records to Vercel
3. Enable proxy mode (orange cloud) for CDN + DDoS protection

## Cache Rules

### Cache (public, read-only endpoints)
```
GET /api/products         → cache 60s (s-maxage=60)
GET /api/products/:id     → cache 60s
GET /api/delivery/zones   → cache 300s
GET /api/public/stores/*  → cache 120s
GET /openapi.json         → cache 3600s
```

### Bypass (authenticated/dynamic)
```
Any request with Authorization header → bypass cache
/api/auth/*     → bypass
/api/cart/*     → bypass
/api/orders/*   → bypass
/api/payments/* → bypass
/api/admin/*    → bypass
/api/vendors/*  → bypass
/api/notifications/* → bypass
```

## DDoS / Rate Limit
- Cloudflare's free tier includes basic DDoS protection
- Add WAF rule: block requests from known bot ASNs
- Rate limit: 100 req/min per IP on /api/auth/* (supplements app-level rate limiter)

## Cache Purge Procedure
1. Cloudflare Dashboard → Caching → Purge Everything
2. Or API: `POST https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache`
3. Purge after: product updates, delivery zone changes, spec updates
