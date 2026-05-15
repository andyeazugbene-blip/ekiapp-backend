/**
 * Public vendor storefront page for Expo Router.
 *
 * Drop this file into your Expo app at: app/store/[slug].tsx
 *
 * It fetches the public store profile and products from the backend
 * (no auth required) and renders a responsive store page that works
 * on web (neon.online/store/<slug>) and inside the mobile app.
 *
 * Required env (Expo):
 *   EXPO_PUBLIC_API_BASE_URL=https://italian-market-place.vercel.app
 *
 * Optional env:
 *   EXPO_PUBLIC_STORE_BASE_URL=https://neon.online   (used for share links)
 */

import { useEffect, useState, useCallback } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams } from "expo-router";

// ─── Types ────────────────────────────────────────────────────────────────

type VerificationStatus = "PENDING" | "VERIFIED" | "REJECTED";

interface PublicStore {
  vendorId: string;
  storeName: string;
  storeSlug: string;
  shareUrl: string;
  description: string | null;
  avatar: string | null;
  coverImage: string | null;
  city: string | null;
  country: string | null;
  verificationStatus: VerificationStatus;
  rating: number | null;
  totalProducts: number;
  deliveryCountries: string[];
  createdAt: string;
}

interface PublicProduct {
  id: string;
  vendorId: string;
  title: string;
  description: string | null;
  priceInCents: number;
  currency: string;
  images: string[];
  category: string | null;
  stock: number;
  weightGrams: number | null;
  createdAt: string;
}

// ─── Config ───────────────────────────────────────────────────────────────

const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://italian-market-place.vercel.app";
const STORE_BASE_URL =
  process.env.EXPO_PUBLIC_STORE_BASE_URL ?? "https://neon.online";

// ─── Utilities ────────────────────────────────────────────────────────────

function formatPrice(priceInCents: number, currency: string): string {
  const amount = priceInCents / 100;
  const code = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const error = new Error(`Request failed (${res.status})`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as T;
}

// ─── Component ────────────────────────────────────────────────────────────

export default function StorePage(): JSX.Element {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const slugStr = (Array.isArray(slug) ? slug[0] : slug) ?? "";

  const { width } = useWindowDimensions();
  const numColumns = width >= 1024 ? 4 : width >= 700 ? 3 : 2;

  const [store, setStore] = useState<PublicStore | null>(null);
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErrorStatus(null);
      try {
        const [storeRes, productsRes] = await Promise.all([
          fetchJson<{ store: PublicStore }>(`${API_BASE_URL}/api/public/stores/${slugStr}`),
          fetchJson<{ items: PublicProduct[]; nextCursor: string | null }>(
            `${API_BASE_URL}/api/public/stores/${slugStr}/products?limit=24`,
          ),
        ]);
        if (cancelled) return;
        setStore(storeRes.store);
        setProducts(productsRes.items);
      } catch (err) {
        if (cancelled) return;
        const status = (err as { status?: number }).status ?? 500;
        setErrorStatus(status);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (slugStr) load();
    return () => {
      cancelled = true;
    };
  }, [slugStr]);

  const handleShare = useCallback(async () => {
    if (!store) return;
    const url = `${STORE_BASE_URL}/store/${store.storeSlug}`;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // ignore clipboard errors silently
      }
      return;
    }
    try {
      await Share.share({ message: url, url });
    } catch {
      // user dismissed
    }
  }, [store]);

  const handleOpenInApp = useCallback(() => {
    if (!store) return;
    const deepLink = `neon://store/${store.storeSlug}`;
    Linking.openURL(deepLink).catch(() => {
      // fallback: stay on web
    });
  }, [store]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (errorStatus === 404 || !store) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Store not found</Text>
        <Text style={styles.errorSubtitle}>
          The store {slugStr ? `"${slugStr}"` : ""} could not be found.
        </Text>
      </View>
    );
  }

  if (errorStatus) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Something went wrong</Text>
        <Text style={styles.errorSubtitle}>Please try again in a moment.</Text>
      </View>
    );
  }

  const location = [store.city, store.country].filter(Boolean).join(", ");

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {/* Cover */}
      {store.coverImage ? (
        <Image source={{ uri: store.coverImage }} style={styles.cover} />
      ) : (
        <View style={[styles.cover, styles.coverPlaceholder]} />
      )}

      {/* Header */}
      <View style={styles.headerRow}>
        {store.avatar ? (
          <Image source={{ uri: store.avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Text style={styles.avatarPlaceholderText}>
              {store.storeName.slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.headerMeta}>
          <View style={styles.titleRow}>
            <Text style={styles.storeName} numberOfLines={2}>
              {store.storeName}
            </Text>
            {store.verificationStatus === "VERIFIED" && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>✓ Verified</Text>
              </View>
            )}
          </View>
          {!!location && <Text style={styles.location}>{location}</Text>}
          {!!store.description && (
            <Text style={styles.description}>{store.description}</Text>
          )}
          {store.deliveryCountries.length > 0 && (
            <View style={styles.chipsRow}>
              <Text style={styles.chipsLabel}>Delivers to:</Text>
              {store.deliveryCountries.map((c) => (
                <View key={c} style={styles.chip}>
                  <Text style={styles.chipText}>{c}</Text>
                </View>
              ))}
            </View>
          )}
          <View style={styles.actionsRow}>
            <Pressable style={[styles.btn, styles.btnSecondary]} onPress={handleShare}>
              <Text style={styles.btnSecondaryText}>
                {Platform.OS === "web" ? "Copy link" : "Share"}
              </Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={handleOpenInApp}>
              <Text style={styles.btnPrimaryText}>Open in app</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* Stats */}
      <Text style={styles.stats}>
        {store.totalProducts} active product{store.totalProducts === 1 ? "" : "s"}
      </Text>

      {/* Products */}
      {products.length === 0 ? (
        <Text style={styles.empty}>This store has no products yet.</Text>
      ) : (
        <FlatList
          key={`grid-${numColumns}`}
          data={products}
          numColumns={numColumns}
          keyExtractor={(item) => item.id}
          scrollEnabled={false}
          columnWrapperStyle={numColumns > 1 ? styles.productRow : undefined}
          contentContainerStyle={styles.productList}
          renderItem={({ item }) => (
            <View style={[styles.product, { flex: 1 / numColumns }]}>
              {item.images[0] ? (
                <Image source={{ uri: item.images[0] }} style={styles.productImage} />
              ) : (
                <View style={[styles.productImage, styles.productImagePlaceholder]}>
                  <Text style={styles.productImagePlaceholderText}>No image</Text>
                </View>
              )}
              <View style={styles.productBody}>
                <Text style={styles.productTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.productPrice}>
                  {formatPrice(item.priceInCents, item.currency)}
                </Text>
                <Text
                  style={[
                    styles.productStock,
                    item.stock > 0 ? styles.inStock : styles.outOfStock,
                  ]}
                >
                  {item.stock > 0 ? "In stock" : "Sold out"}
                </Text>
              </View>
            </View>
          )}
        />
      )}
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#f8fafc" },
  scrollContent: { paddingBottom: 48 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#f8fafc",
  },
  errorTitle: { fontSize: 22, fontWeight: "700", color: "#0f172a", marginBottom: 8 },
  errorSubtitle: { color: "#64748b", textAlign: "center" },
  cover: { width: "100%", height: 200, backgroundColor: "#1e293b" },
  coverPlaceholder: { backgroundColor: "#6366f1" },
  headerRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    marginTop: -36,
    gap: 16,
    alignItems: "flex-end",
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 16,
    borderWidth: 4,
    borderColor: "#fff",
    backgroundColor: "#fff",
  },
  avatarPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#eef2ff",
  },
  avatarPlaceholderText: { fontSize: 32, fontWeight: "700", color: "#6366f1" },
  headerMeta: { flex: 1, paddingBottom: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  storeName: { fontSize: 22, fontWeight: "700", color: "#0f172a", flexShrink: 1 },
  badge: {
    backgroundColor: "#dbeafe",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  badgeText: { color: "#1d4ed8", fontSize: 12, fontWeight: "600" },
  location: { color: "#64748b", marginTop: 4, fontSize: 14 },
  description: { color: "#334155", marginTop: 8, fontSize: 15, lineHeight: 21 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginTop: 10, gap: 6 },
  chipsLabel: { color: "#64748b", fontSize: 13, marginRight: 4 },
  chip: { backgroundColor: "#e2e8f0", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  chipText: { color: "#0f172a", fontSize: 12 },
  actionsRow: { flexDirection: "row", marginTop: 14, gap: 8, flexWrap: "wrap" },
  btn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
  btnPrimary: { backgroundColor: "#0f172a" },
  btnPrimaryText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  btnSecondary: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#cbd5e1" },
  btnSecondaryText: { color: "#0f172a", fontWeight: "600", fontSize: 14 },
  stats: { color: "#64748b", fontSize: 14, paddingHorizontal: 16, marginTop: 24, marginBottom: 12 },
  empty: { textAlign: "center", color: "#64748b", padding: 40 },
  productList: { paddingHorizontal: 12, gap: 12 },
  productRow: { gap: 12, marginBottom: 12 },
  product: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    overflow: "hidden",
  },
  productImage: { width: "100%", aspectRatio: 1, backgroundColor: "#f1f5f9" },
  productImagePlaceholder: { alignItems: "center", justifyContent: "center" },
  productImagePlaceholderText: { color: "#94a3b8", fontSize: 12 },
  productBody: { padding: 10 },
  productTitle: { fontWeight: "600", color: "#0f172a", fontSize: 14, lineHeight: 18 },
  productPrice: { fontWeight: "700", color: "#0f172a", fontSize: 15, marginTop: 4 },
  productStock: { fontSize: 12, marginTop: 2 },
  inStock: { color: "#15803d" },
  outOfStock: { color: "#b91c1c" },
});
