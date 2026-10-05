import crypto from "crypto";

import { env } from "../../config/env";
import { constantTimeEqual } from "../../shared/utils/crypto";

// ─── Deep links ─────────────────────────────────────────────────────────────

/**
 * App routes a broadcast may deep-link to. The mobile app (app/_layout.tsx)
 * validates the same shape before navigating, so an unknown or malformed link
 * is rejected here AND ignored there.
 */
export const ALLOWED_DEEP_LINKS: Array<{ path: string; label: string; audience: "buyer" | "vendor" }> = [
  { path: "/(buyer)", label: "Buyer home", audience: "buyer" },
  { path: "/(buyer)/deals", label: "Deals", audience: "buyer" },
  { path: "/(buyer)/explore", label: "Explore", audience: "buyer" },
  { path: "/(buyer)/orders", label: "My orders", audience: "buyer" },
  { path: "/(buyer)/community-buy", label: "Community Buy", audience: "buyer" },
  { path: "/(buyer)/regular-deliveries", label: "Regular Deliveries", audience: "buyer" },
  { path: "/(buyer)/messages", label: "Messages", audience: "buyer" },
  { path: "/(buyer)/invite-friend", label: "Invite a friend", audience: "buyer" },
  { path: "/(buyer)/wallet", label: "Wallet", audience: "buyer" },
  { path: "/(vendor)", label: "Seller home", audience: "vendor" },
  { path: "/(vendor)/orders", label: "Seller orders", audience: "vendor" },
  { path: "/(vendor)/foodstuff", label: "Seller products", audience: "vendor" },
  { path: "/(vendor)/grow-sales", label: "Grow sales", audience: "vendor" },
  { path: "/(vendor)/automation-center", label: "Automation centre", audience: "vendor" },
  { path: "/(vendor)/subscription-plans", label: "Seller plans", audience: "vendor" },
  { path: "/(vendor)/messages", label: "Seller messages", audience: "vendor" },
];

const DEEP_LINK_QUERY = /^[A-Za-z0-9=&_.\-]*$/;

/** Returns the normalised link, or throws an Error whose message is user-safe. */
export function validateDeepLink(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("deepLink must be a string");
  const link = raw.trim();
  if (link.length > 200) throw new Error("deepLink is too long");
  const [path, query, ...rest] = link.split("?");
  if (rest.length > 0) throw new Error("deepLink is not a valid app route");
  if (!ALLOWED_DEEP_LINKS.some((l) => l.path === path)) {
    throw new Error("deepLink must be one of the supported app routes");
  }
  if (query !== undefined && !DEEP_LINK_QUERY.test(query)) throw new Error("deepLink query string is invalid");
  return link;
}

// ─── Template variables ─────────────────────────────────────────────────────

export const BROADCAST_VARIABLES = ["name", "store_name"] as const;

/** Placeholders in `text` that a broadcast cannot fill. */
export function unsupportedVariables(text: string): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!(BROADCAST_VARIABLES as readonly string[]).includes(m[1])) bad.add(m[1]);
  }
  return [...bad];
}

export function renderVariables(text: string, vars: { name?: string | null; store_name?: string | null }): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key === "name") return vars.name?.trim() || "there";
    if (key === "store_name") return vars.store_name?.trim() || "your store";
    return "";
  });
}

// ─── Unsubscribe tokens (marketing email) ───────────────────────────────────

function hmac(data: string): string {
  return crypto.createHmac("sha256", env.jwtSecret).update(`unsub:${data}`).digest("base64url");
}

export function signUnsubscribeToken(userId: string): string {
  return `${Buffer.from(userId, "utf8").toString("base64url")}.${hmac(userId)}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  const [idPart, sig] = (token ?? "").split(".");
  if (!idPart || !sig) return null;
  let userId: string;
  try {
    userId = Buffer.from(idPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  return userId && constantTimeEqual(sig, hmac(userId)) ? userId : null;
}

export function unsubscribeUrl(userId: string): string {
  const base = (process.env.PUBLIC_API_URL ?? `${env.publicStoreBaseUrl}/api`).replace(/\/+$/, "");
  return `${base}/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(userId))}`;
}

/** Headers + footer HTML for a marketing email. */
export function marketingEmailExtras(userId: string): { headers: Record<string, string>; footerHtml: string; url: string } {
  const url = unsubscribeUrl(userId);
  return {
    url,
    headers: {
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    footerHtml: `<p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:12px;">You are receiving this because you opted in to Eki updates. <a href="${url}" style="color:#6b7280;">Unsubscribe</a></p>`,
  };
}

// ─── Mandatory test-send proof ──────────────────────────────────────────────

const TEST_TOKEN_TTL_MS = 60 * 60 * 1000;

export function broadcastContentHash(content: {
  subject: string;
  body: string;
  channels: string[];
  deepLink?: string;
  category: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      s: content.subject,
      b: content.body,
      c: [...content.channels].sort(),
      d: content.deepLink ?? "",
      k: content.category,
    }))
    .digest("hex");
}

/** Proof that THIS admin test-sent THIS exact content (all selected channels succeeded). */
export function signTestToken(actorId: string, contentHash: string): string {
  const exp = Date.now() + TEST_TOKEN_TTL_MS;
  const sig = crypto.createHmac("sha256", env.jwtSecret).update(`test:${actorId}:${contentHash}:${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifyTestToken(token: unknown, actorId: string, contentHash: string): boolean {
  if (typeof token !== "string") return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = crypto.createHmac("sha256", env.jwtSecret).update(`test:${actorId}:${contentHash}:${exp}`).digest("base64url");
  return constantTimeEqual(sig, expected);
}
