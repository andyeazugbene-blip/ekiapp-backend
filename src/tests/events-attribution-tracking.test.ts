import crypto from "crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: { communicationLog: { findFirst: m.findFirst, updateMany: m.updateMany, update: m.update } },
}));
vi.mock("../modules/events/events.service", () => ({
  EVENT_NAMES: new Proxy({}, { get: (_t, name) => name }),
  eventsService: { emit: m.emit },
}));
vi.mock("../modules/admin/launch-settings.service", () => ({ launchSettingsService: { get: vi.fn() } }));

import { attributeOrders } from "../modules/automation/automation-attribution.service";
import { applyResendEvent, verifyResendSignature } from "../modules/communications/resend-webhook.routes";

const SECRET = `whsec_${Buffer.from("local-test-signing-value").toString("base64")}`;
const NOW = Date.parse("2026-11-06T12:00:00Z");

function sign(body: string, id = "msg_1", timestamp = String(Math.floor(NOW / 1000))) {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const value = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { id, timestamp, signature: `v1,${value}` };
}

describe("verifyResendSignature", () => {
  const body = '{"type":"email.opened"}';

  it("accepts a correct signature", () => {
    expect(verifyResendSignature(body, sign(body), SECRET, NOW)).toBe(true);
  });

  it("accepts a correct signature among several, for secret rotation", () => {
    const headers = sign(body);
    expect(verifyResendSignature(body, { ...headers, signature: `v1,wrong ${headers.signature}` }, SECRET, NOW)).toBe(true);
  });

  it("refuses a changed body", () => {
    expect(verifyResendSignature('{"type":"email.clicked"}', sign(body), SECRET, NOW)).toBe(false);
  });

  it("refuses a replayed old message", () => {
    expect(verifyResendSignature(body, sign(body), SECRET, NOW + 6 * 60 * 1000)).toBe(false);
  });

  it("refuses missing headers", () => {
    expect(verifyResendSignature(body, {}, SECRET, NOW)).toBe(false);
  });
});

describe("applyResendEvent", () => {
  const log = { id: "log1", recipientId: "u1", eventKey: "automation_cart_recovery", broadcastId: null };
  const names = () => m.emit.mock.calls.map((call) => call[0].name);

  beforeEach(() => {
    vi.clearAllMocks();
    m.findFirst.mockResolvedValue(log);
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("finds the row by the log tag, in either tag format", async () => {
    await applyResendEvent({ type: "email.opened", data: { tags: { log_id: "log1" } } });
    expect(m.findFirst.mock.calls[0][0].where).toEqual({ id: "log1" });

    await applyResendEvent({ type: "email.opened", data: { tags: [{ name: "log_id", value: "log2" }] } });
    expect(m.findFirst.mock.calls[1][0].where).toEqual({ id: "log2" });
  });

  it("falls back to the provider id for broadcast emails", async () => {
    await applyResendEvent({ type: "email.opened", data: { email_id: "re_1" } });
    expect(m.findFirst.mock.calls[0][0].where).toEqual({ providerRef: "re_1" });
  });

  it("ignores an email it has no record of", async () => {
    m.findFirst.mockResolvedValue(null);
    expect(await applyResendEvent({ type: "email.opened", data: { email_id: "re_x" } })).toBe("ignored");
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("doesn't emit twice when a webhook repeats", async () => {
    m.updateMany.mockResolvedValue({ count: 0 });
    await applyResendEvent({ type: "email.opened", data: { email_id: "re_1" } });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("delivered only moves a row forward from queued or sent", async () => {
    await applyResendEvent({ type: "email.delivered", data: { email_id: "re_1" } });
    expect(m.updateMany.mock.calls[0][0].where.status).toEqual({ in: ["QUEUED", "SENT"] });
    expect(names()).toEqual(["message_delivered"]);
  });

  it("a bounce is recorded as failed with the reason", async () => {
    await applyResendEvent({ type: "email.bounced", data: { email_id: "re_1", bounce: { message: "Mailbox full" } } });
    expect(m.updateMany.mock.calls[0][0].data).toEqual({ status: "FAILED", statusDetail: "Mailbox full" });
    expect(names()).toEqual(["message_failed"]);
  });

  it("a click also records the open, and counts as an automation click", async () => {
    await applyResendEvent({ type: "email.clicked", data: { email_id: "re_1" } });
    expect(names()).toEqual(["message_opened", "message_clicked", "automation_clicked"]);
  });

  it("a click on a broadcast is not an automation click", async () => {
    m.findFirst.mockResolvedValue({ ...log, eventKey: "admin_broadcast" });
    await applyResendEvent({ type: "email.clicked", data: { email_id: "re_1" } });
    expect(names()).not.toContain("automation_clicked");
  });

  it("ignores event types it doesn't handle", async () => {
    expect(await applyResendEvent({ type: "email.sent", data: { email_id: "re_1" } })).toBe("ignored");
  });
});

describe("attributeOrders", () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (d: number) => new Date(NOW + d * day);
  const order = (over: Record<string, unknown> = {}) => ({
    id: "o1", buyerId: "b1", createdAt: at(2), totalAmount: 1000, currency: "GBP",
    items: [{ vendorId: "v1", totalAmount: 600 }, { vendorId: "v2", totalAmount: 400 }], refunds: [], ...over,
  });
  const run = (over: Record<string, unknown> = {}) => ({ type: "CART_RECOVERY", vendorId: null, recipientUserId: "b1", sentAt: at(0), ...over });

  it("counts an order inside the window", () => {
    expect(attributeOrders([run()], [order()], 7 * day)).toEqual([{ type: "CART_RECOVERY", currency: "GBP", gross: 1000, refunds: 0 }]);
  });

  it("doesn't count an order outside the window", () => {
    expect(attributeOrders([run()], [order({ createdAt: at(8) })], 7 * day)).toEqual([]);
  });

  it("doesn't count an order placed before the automation", () => {
    expect(attributeOrders([run({ sentAt: at(3) })], [order()], 7 * day)).toEqual([]);
  });

  it("doesn't credit another buyer's automation", () => {
    expect(attributeOrders([run({ recipientUserId: "b2" })], [order()], 7 * day)).toEqual([]);
  });

  it("counts each order once, for the most recent automation", () => {
    const result = attributeOrders([run({ type: "REVIEW_REQUEST" }), run({ type: "BUYER_WIN_BACK", sentAt: at(1) })], [order()], 7 * day);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("BUYER_WIN_BACK");
  });

  it("a vendor's automation only counts that vendor's items", () => {
    expect(attributeOrders([run({ vendorId: "v1" })], [order()], 7 * day)[0].gross).toBe(600);
  });

  it("a vendor's automation doesn't count an order from other vendors", () => {
    expect(attributeOrders([run({ vendorId: "v9" })], [order()], 7 * day)).toEqual([]);
  });

  it("never deducts more refund than the attributed amount", () => {
    const result = attributeOrders([run({ vendorId: "v2" })], [order({ refunds: [{ amountMinor: 900 }] })], 7 * day);
    expect(result[0]).toMatchObject({ gross: 400, refunds: 400 });
  });
});
