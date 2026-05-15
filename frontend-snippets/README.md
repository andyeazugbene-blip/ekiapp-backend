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
EXPO_PUBLIC_STORE_BASE_URL=https://neon.online
```

#### What it does

- Fetches `GET /api/public/stores/:slug` and `GET /api/public/stores/:slug/products`
- Renders a responsive store page (cover, avatar, verified badge, description, delivery countries, product grid)
- Handles loading, 404, and generic error states
- Share button copies `https://neon.online/store/<slug>` (web) or opens the native share sheet (mobile)
- "Open in app" tries `neon://store/<slug>` deep link

#### Domain mapping

For `https://neon.online/store/<slug>` to load the Expo Web build, you must point the `neon.online` domain at:
- The Expo Web deployment that contains this route, OR
- This backend (which serves a server-rendered fallback at `/store/:slug` — see `src/modules/public-stores/public-stores.page.ts`)

Currently the backend at `https://italian-market-place.vercel.app/store/<slug>` returns a fully server-rendered HTML page, so share links work even without the Expo Web build.

#### Sharing

`vendor.shareUrl` returned by the backend is the canonical share URL. Use it directly in any "Share Store" action:

```ts
const shareUrl = vendor.shareUrl; // e.g. "https://neon.online/store/mama-chi-foodstuff"
```

If `shareUrl` is missing in older responses, fall back to:

```ts
const shareUrl = `${process.env.EXPO_PUBLIC_STORE_BASE_URL ?? "https://neon.online"}/store/${vendor.storeSlug}`;
```
