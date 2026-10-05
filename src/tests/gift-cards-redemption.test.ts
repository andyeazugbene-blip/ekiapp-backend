/**
 * Handbook 14.4 gift cards: code format/uniqueness, atomic redemption (double
 * redeem), expiry/status enforcement, webhook paid-marking idempotency, unpaid
 * rows hidden. Prisma is replaced by a tiny in-memory store whose conditional
 * updateMany is check-and-set, mirroring the DB guarantee the service relies on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  cards: new Map<string, any>(),
  wallets: new Map<string, any>(),
  walletTxs: [] as any[],
  redemptions: [] as any[],
  findManyArgs: [] as any[],
  seq: 0,
}));

function matches(card: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === "OR") {
      if (!(v as any[]).some((w) => matches(card, w))) return false;
    } else if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = v as any;
      if ("gte" in o && !(card[k] >= o.gte)) return false;
      if ("gt" in o && !(card[k] > o.gt)) return false;
      if ("not" in o && card[k] === o.not) return false;
    } else if (card[k] !== v) return false;
  }
  return true;
}

function applyData(card: any, data: any) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "decrement" in (v as any)) card[k] -= (v as any).decrement;
    else if (v && typeof v === "object" && "increment" in (v as any)) card[k] += (v as any).increment;
    else card[k] = v;
  }
}

vi.mock("../lib/prisma", () => {
  const cardApi = {
    findUnique: async ({ where }: any) => {
      const c = where.id ? store.cards.get(where.id) : [...store.cards.values()].find((x) => x.code === where.code);
      return c ? { ...c, giftCard: { title: "Card" }, buyer: { name: "Buyer", email: "b@x.test" } } : null;
    },
    findMany: async (args: any) => {
      store.findManyArgs.push(args);
      return [...store.cards.values()].filter((c) => matches(c, args.where)).map((c) => ({ ...c, giftCard: { title: "Card", imageUrl: null } }));
    },
    updateMany: async ({ where, data }: any) => {
      const hits = [...store.cards.values()].filter((c) => (where.id ? c.id === where.id : true) && matches(c, Object.fromEntries(Object.entries(where).filter(([k]) => k !== "id"))));
      hits.forEach((c) => applyData(c, data));
      return { count: hits.length };
    },
    update: async ({ where, data }: any) => {
      const c = store.cards.get(where.id);
      applyData(c, data);
      return c;
    },
  };
  const tx = {
    purchasedGiftCard: cardApi,
    buyerWallet: {
      findUnique: async ({ where }: any) => store.wallets.get(where.buyerId) ?? null,
      create: async ({ data }: any) => {
        const w = { id: `w-${data.buyerId}`, balance: 0, ...data };
        store.wallets.set(data.buyerId, w);
        return w;
      },
      update: async ({ where, data }: any) => {
        const w = [...store.wallets.values()].find((x) => x.id === where.id);
        applyData(w, data);
        return w;
      },
    },
    buyerWalletTransaction: {
      create: async ({ data }: any) => {
        const t = { id: `wt-${++store.seq}`, ...data };
        store.walletTxs.push(t);
        return t;
      },
    },
    giftCardRedemption: {
      create: async ({ data }: any) => {
        const r = { id: `r-${++store.seq}`, ...data };
        store.redemptions.push(r);
        return r;
      },
    },
  };
  return {
    prisma: { ...tx, $transaction: async (fn: any) => fn(tx), user: { findMany: async () => [] } },
  };
});
vi.mock("../lib/stripe", () => ({ stripe: { paymentIntents: { create: vi.fn() } } }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { giftCardsService } from "../modules/gift-cards/gift-cards.service";
import {
  formatGiftCardCode,
  generateGiftCardCode,
  maskGiftCardCode,
  normaliseGiftCardCode,
} from "../modules/gift-cards/gift-card-code";

function seedCard(over: Partial<any> = {}) {
  const id = over.id ?? `c-${++store.seq}`;
  const card = {
    id,
    buyerId: "buyer-1",
    giftCardId: "gc-1",
    amount: 5000,
    currency: "EUR",
    code: generateGiftCardCode(),
    remainingBalance: 5000,
    status: "ACTIVE",
    paidAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    isRedeemed: false,
    createdAt: new Date(),
    recipientEmail: null,
    stripePaymentIntentId: "pi_1",
    ...over,
  };
  store.cards.set(id, card);
  return card;
}

beforeEach(() => {
  store.cards.clear();
  store.wallets.clear();
  store.walletTxs.length = 0;
  store.redemptions.length = 0;
  store.findManyArgs.length = 0;
});

describe("gift card codes", () => {
  it("are 16 chars, unambiguous alphabet, and unique across 5000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const c = generateGiftCardCode();
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{16}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(5000);
  });

  it("format / normalise round-trips and rejects malformed input", () => {
    const c = generateGiftCardCode();
    const shown = formatGiftCardCode(c);
    expect(shown).toMatch(/^\w{4}-\w{4}-\w{4}-\w{4}$/);
    expect(normaliseGiftCardCode(shown.toLowerCase())).toBe(c);
    expect(normaliseGiftCardCode("short")).toBeNull();
    expect(normaliseGiftCardCode("0000-0000-0000-0000")).toBeNull();
    expect(maskGiftCardCode(c)).toMatch(/-\w{4}$/);
    expect(maskGiftCardCode(c)).not.toContain(c.slice(0, 8));
  });
});

describe("redeem", () => {
  it("credits the wallet, writes the ledger row and marks the card REDEEMED", async () => {
    const card = seedCard();
    const res = await giftCardsService.redeem("user-2", { code: formatGiftCardCode(card.code) });
    expect(res.amountMinor).toBe(5000);
    expect(res.status).toBe("REDEEMED");
    expect(store.wallets.get("user-2").balance).toBe(5000);
    expect(store.walletTxs).toHaveLength(1);
    expect(store.redemptions[0]).toMatchObject({ redeemerId: "user-2", amountMinor: 5000, balanceAfter: 0 });
    expect(store.cards.get(card.id).status).toBe("REDEEMED");
  });

  it("supports partial redemption and keeps the card ACTIVE", async () => {
    const card = seedCard();
    const res = await giftCardsService.redeem("user-2", { code: card.code, amount: 1500 });
    expect(res.remainingBalance).toBe(3500);
    expect(res.status).toBe("ACTIVE");
  });

  it("double redeem in parallel: exactly one wins, wallet credited once", async () => {
    const card = seedCard();
    const results = await Promise.allSettled([
      giftCardsService.redeem("user-2", { code: card.code }),
      giftCardsService.redeem("user-3", { code: card.code }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(["GIFT_CARD_CONFLICT", "GIFT_CARD_ALREADY_REDEEMED"]).toContain(bad[0].reason.code);
    const credited = [...store.wallets.values()].reduce((s, w) => s + w.balance, 0);
    expect(credited).toBe(5000);
    expect(store.redemptions).toHaveLength(1);
    expect(store.cards.get(card.id).remainingBalance).toBe(0);
  });

  it("a second redemption after full redemption is refused", async () => {
    const card = seedCard();
    await giftCardsService.redeem("user-2", { code: card.code });
    await expect(giftCardsService.redeem("user-2", { code: card.code })).rejects.toMatchObject({ code: "GIFT_CARD_ALREADY_REDEEMED", statusCode: 409 });
  });

  it("refuses an expired card (410) and marks it EXPIRED", async () => {
    const card = seedCard({ expiresAt: new Date(Date.now() - 1000) });
    await expect(giftCardsService.redeem("user-2", { code: card.code })).rejects.toMatchObject({ code: "GIFT_CARD_EXPIRED", statusCode: 410 });
    expect(store.cards.get(card.id).status).toBe("EXPIRED");
    expect(store.wallets.size).toBe(0);
  });

  it("refuses unpaid, cancelled and paused cards, over-amount and bad codes", async () => {
    const unpaid = seedCard({ status: "PENDING_PAYMENT", paidAt: null });
    const cancelled = seedCard({ status: "CANCELLED" });
    const paused = seedCard({ status: "PAUSED" });
    const active = seedCard();
    await expect(giftCardsService.redeem("u", { code: unpaid.code })).rejects.toMatchObject({ code: "GIFT_CARD_NOT_FOUND" });
    await expect(giftCardsService.redeem("u", { code: cancelled.code })).rejects.toMatchObject({ code: "GIFT_CARD_CANCELLED" });
    await expect(giftCardsService.redeem("u", { code: paused.code })).rejects.toMatchObject({ code: "GIFT_CARD_PAUSED" });
    await expect(giftCardsService.redeem("u", { code: active.code, amount: 5001 })).rejects.toMatchObject({ code: "GIFT_CARD_INSUFFICIENT_BALANCE" });
    await expect(giftCardsService.redeem("u", { code: "nope" })).rejects.toMatchObject({ code: "GIFT_CARD_NOT_FOUND" });
    expect(store.walletTxs).toHaveLength(0);
  });

  it("refuses a funded wallet in a different currency", async () => {
    store.wallets.set("user-2", { id: "w-user-2", buyerId: "user-2", balance: 100, currency: "gbp" });
    const card = seedCard();
    await expect(giftCardsService.redeem("user-2", { code: card.code })).rejects.toMatchObject({ code: "GIFT_CARD_CURRENCY_MISMATCH" });
  });
});

describe("activatePaidGiftCard (webhook paid marking)", () => {
  const params = { purchasedGiftCardId: "p1", paymentIntentId: "pi_1", amount: 5000, currency: "eur" };

  it("activates once: code, balance, expiry, paidAt; replay is a no-op", async () => {
    seedCard({ id: "p1", status: "PENDING_PAYMENT", paidAt: null, code: null, remainingBalance: 0, expiresAt: null, recipientEmail: "r@x.test" });
    const first = await giftCardsService.activatePaidGiftCard(prisma as any, params);
    expect(first.outcome).toBe("ACTIVATED");
    const after = { ...store.cards.get("p1") };
    expect(after.status).toBe("ACTIVE");
    expect(after.remainingBalance).toBe(5000);
    expect(after.code).toMatch(/^[A-Z0-9]{16}$/);
    expect(after.paidAt).toBeInstanceOf(Date);
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const second = await giftCardsService.activatePaidGiftCard(prisma as any, params);
    expect(second.outcome).toBe("ALREADY_PAID");
    expect(store.cards.get("p1").code).toBe(after.code);
  });

  it("does not activate on amount mismatch or an admin-cancelled purchase", async () => {
    seedCard({ id: "p1", status: "PENDING_PAYMENT", paidAt: null, code: null, remainingBalance: 0 });
    expect((await giftCardsService.activatePaidGiftCard(prisma as any, { ...params, amount: 1 })).outcome).toBe("MISMATCH");
    store.cards.get("p1").status = "CANCELLED";
    store.cards.get("p1").statusChangedById = "admin-1";
    expect((await giftCardsService.activatePaidGiftCard(prisma as any, params)).outcome).toBe("CLOSED");
    expect(store.cards.get("p1").paidAt).toBeNull();
  });
});

describe("listPurchased", () => {
  it("only asks for paid, non-pending rows and exposes the code only for them", async () => {
    seedCard({ id: "paid" });
    seedCard({ id: "unpaid", status: "PENDING_PAYMENT", paidAt: null, code: null });
    const list = await giftCardsService.listPurchased("buyer-1");
    expect(list.map((c) => c.id)).toEqual(["paid"]);
    expect(list[0].code).toMatch(/^\w{4}-\w{4}-\w{4}-\w{4}$/);
    expect(store.findManyArgs[0].where).toMatchObject({ buyerId: "buyer-1", paidAt: { not: null } });
  });
});
