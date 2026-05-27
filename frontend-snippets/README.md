# Frontend Snippets

This folder contains code intended for the **separate Expo / React Native frontend repo**, not for this backend. Files here are NOT compiled or shipped by the backend.

## Files

### `app/store/[slug].tsx`

Public vendor storefront page for Expo Router. Drop it into your Expo app at the same path:

```
your-expo-app/
└── app/
    └── store/
        └── [slug].tsx
```

#### Required env vars (Expo)

```
EXPO_PUBLIC_API_BASE_URL=https://italian-market-place.vercel.app
EXPO_PUBLIC_STORE_BASE_URL=https://waqti.pro
```

If you also want the apex/www split, the backend always emits the apex
(`https://waqti.pro/...`); set up a 301 from `www` to apex (or vice versa)
at the DNS/CDN layer.

#### What it does

- Fetches `GET /api/public/stores/:slug` and `GET /api/public/stores/:slug/products`
- Renders a responsive store page (cover, avatar, verified badge, description, delivery countries, product grid)
- Handles loading, 404, and generic error states
- Share button copies `https://waqti.pro/store/<slug>` (web) or opens the native share sheet (mobile)
- "Open in app" tries `waqti://store/<slug>` (custom-scheme deep link)

#### Domain mapping

For `https://waqti.pro/store/<slug>` to load the Expo Web build, point the
`waqti.pro` domain at:

- The Expo Web deployment that contains this route, OR
- This backend (which serves a server-rendered fallback at `/store/:slug` — see `src/modules/public-stores/public-stores.page.ts`)

Currently the backend at `https://italian-market-place.vercel.app/store/<slug>`
returns a fully server-rendered HTML page, so share links work even without
the Expo Web build. After Vercel domain attachment, `https://waqti.pro/store/<slug>`
points at the same handler.

#### iOS / Android deep-link config (Expo)

`app.json` (or `app.config.ts`):

```json
{
  "expo": {
    "scheme": "waqti",
    "ios": {
      "bundleIdentifier": "pro.waqti.app",
      "associatedDomains": [
        "applinks:waqti.pro",
        "applinks:www.waqti.pro"
      ]
    },
    "android": {
      "package": "pro.waqti.app",
      "intentFilters": [
        {
          "action": "VIEW",
          "autoVerify": true,
          "data": [
            { "scheme": "https", "host": "waqti.pro", "pathPrefix": "/store" },
            { "scheme": "https", "host": "www.waqti.pro", "pathPrefix": "/store" }
          ],
          "category": ["BROWSABLE", "DEFAULT"]
        }
      ]
    }
  }
}
```

For App-Links / Universal-Links to verify, the backend at `waqti.pro` must
serve `/.well-known/assetlinks.json` (Android) and
`/.well-known/apple-app-site-association` (iOS). Generate them from the
Expo dashboard once the bundle ID is fixed.

#### Sharing

`vendor.shareUrl` returned by the backend is the canonical share URL. Use it directly in any "Share Store" action:

```ts
const shareUrl = vendor.shareUrl; // e.g. "https://waqti.pro/store/mama-chi-foodstuff"
```

If `shareUrl` is missing in older responses, fall back to:

```ts
const shareUrl = `${process.env.EXPO_PUBLIC_STORE_BASE_URL ?? "https://waqti.pro"}/store/${vendor.storeSlug}`;
```
