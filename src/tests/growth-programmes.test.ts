import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  userFind: vi.fn(),
  subFind: vi.fn(),
  listMethods: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: { user: { findUnique: m.userFind }, vendorSubscription: { findUnique: m.subFind } },
}));
vi.mock("../lib/stripe", () => ({ stripe: { paymentMethods: { list: m.listMethods } } }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));
vi.mock("../modules/events/events.service", () => ({ EVENT_NAMES: {}, eventsService: { emit: vi.fn() } }));

import { funnelBottleneck, rankLaunchProducts } from "../modules/growth/first-sale-campaign.service";
import { suspiciousReferralReason } from "../modules/growth/vendor-referrals.service";

describe("First Sale: launch products", () => {
  const product = (title: string, extra: object) => ({ title, stock: 5, images: [] as string[], weightGrams: null as number | null, description: null as string | null, ...extra });

  it("leads with the most complete, in-stock product", () => {
    const ranked = rankLaunchProducts([
      product("Plain", {}),
      product("Complete", { images: ["a"], weightGrams: 1000, description: "x" }),
      product("Photo", { images: ["a"] }),
    ]);
    expect(ranked.map((p) => p.title)).toEqual(["Complete", "Photo", "Plain"]);
  });

  it("never leads with something out of stock", () => {
    expect(rankLaunchProducts([product("Gone", { stock: 0, images: ["a"], weightGrams: 1 })])).toEqual([]);
  });
});

describe("First Sale: the actual bottleneck", () => {
  it.each([
    [{ visits: 0, baskets: 0, checkouts: 0, payments: 0 }, "visits"],
    [{ visits: 4, baskets: 0, checkouts: 0, payments: 0 }, "baskets"],
    [{ visits: 4, baskets: 2, checkouts: 0, payments: 0 }, "checkouts"],
    [{ visits: 4, baskets: 2, checkouts: 1, payments: 0 }, "payments"],
  ])("%j reads as %s", (funnel, stage) => {
    expect(funnelBottleneck(funnel)?.stage).toBe(stage);
  });

  it("has nothing to say after a payment", () => {
    expect(funnelBottleneck({ visits: 1, baskets: 1, checkouts: 1, payments: 1 })).toBeNull();
  });
});

describe("Referral checks", () => {
  const person = (phone: string | null, email: string | null, vendorId = "v") => ({ phone, vendor: { id: vendorId, contactEmail: email } });

  beforeEach(() => {
    vi.clearAllMocks();
    m.subFind.mockResolvedValue(null);
  });

  it("flags the same phone", async () => {
    m.userFind.mockResolvedValueOnce(person("+44", null)).mockResolvedValueOnce(person("+44", null));
    expect(await suspiciousReferralReason("a", "b")).toBe("same_phone");
  });

  it("flags the same business email, whatever the case", async () => {
    m.userFind.mockResolvedValueOnce(person(null, "Shop@x.co")).mockResolvedValueOnce(person(null, "shop@X.co"));
    expect(await suspiciousReferralReason("a", "b")).toBe("same_business_email");
  });

  it("flags the same card, by fingerprint", async () => {
    m.userFind.mockResolvedValueOnce(person("1", "a@x.co", "v1")).mockResolvedValueOnce(person("2", "b@x.co", "v2"));
    m.subFind.mockResolvedValue({ stripeCustomerId: "cus" });
    m.listMethods.mockResolvedValue({ data: [{ card: { fingerprint: "same" } }] });
    expect(await suspiciousReferralReason("a", "b")).toBe("same_payment_method");
  });

  it("passes different people", async () => {
    m.userFind.mockResolvedValueOnce(person("1", "a@x.co", "v1")).mockResolvedValueOnce(person("2", "b@x.co", "v2"));
    m.subFind.mockResolvedValueOnce({ stripeCustomerId: "cus1" }).mockResolvedValueOnce({ stripeCustomerId: "cus2" });
    m.listMethods.mockResolvedValueOnce({ data: [{ card: { fingerprint: "one" } }] }).mockResolvedValueOnce({ data: [{ card: { fingerprint: "two" } }] });
    expect(await suspiciousReferralReason("a", "b")).toBeNull();
  });

  it("a check that can't run doesn't block the payment behind it", async () => {
    m.userFind.mockRejectedValue(new Error("db down"));
    expect(await suspiciousReferralReason("a", "b")).toBeNull();
  });
});
