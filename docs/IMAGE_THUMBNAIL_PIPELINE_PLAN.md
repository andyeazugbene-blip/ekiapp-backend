# Image Thumbnail Pipeline Plan

## Options

### Option A: Cloudflare Images (Recommended)
- Automatic resizing via URL params
- No server-side processing needed
- Format: `https://imagedelivery.net/{account}/{image_id}/{variant}`
- Variants configured in Cloudflare dashboard

### Option B: Sharp-based (Self-hosted)
- Process on upload or on-demand
- Store variants in R2
- Requires compute (not ideal for serverless)

## Target Variants

| Variant | Width | Use Case |
|---------|-------|----------|
| thumb | 300px | Product list cards |
| medium | 800px | Product detail |
| large | 1600px | Full-screen / zoom |

## Implementation (Cloudflare Images)
1. Enable Cloudflare Images on account
2. On product image upload, also upload to Cloudflare Images
3. Store the Cloudflare image ID alongside the R2 URL
4. Frontend uses variant URLs for display

## CDN Caching Strategy
- Product images: cache indefinitely (immutable filenames with hash)
- Cache-Control: `public, max-age=31536000, immutable`
- On product update: new image = new URL (no purge needed)

## Frontend Usage
```tsx
// Product list
<Image source={{ uri: product.images[0] + "?w=300" }} />

// Product detail
<Image source={{ uri: product.images[0] + "?w=800" }} />
```

Note: If using R2 directly (no Cloudflare Images), frontend should use the full-size image. Thumbnail generation would require a separate service.
