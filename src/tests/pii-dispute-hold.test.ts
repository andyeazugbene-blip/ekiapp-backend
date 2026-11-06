import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  userFind: vi.fn(),
  auditCreate: vi.fn(),
  campaignFind: vi.fn(),
  caseCount: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: m.userFind },
    auditLog: { create: m.auditCreate },
    communityCampaign: { findUnique: m.campaignFind },
    communityBuySupportCase: { count: m.caseCount },
  },
}));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { enqueue: vi.fn() } }));

import { adminContactPrivacy, maskContactDeep, revealUserContact } from "../modules/admin/admin-pii";
import { assertNoCampaignDispute, campaignDisputeBlockers } from "../modules/community-buy/campaign-dispute.service";

describe("maskContactDeep", () => {
  it("masks nested contact details and keeps everything else", () => {
    const at = new Date("2026-11-06T00:00:00Z");
    const out = maskContactDeep({
      id: "u1", email: "jane.doe@example.com", emailVerifiedAt: at, phoneVerifiedAt: null,
      buyer: { name: "Jane", email: "jane@example.com" },
      items: [{ user: { contactEmail: "shop@example.com", contactPhone: "+447700900123", phone: "+447700900124" } }],
    });
    expect(out.email).toBe("j•••@example.com");
    expect(out.emailVerifiedAt).toBe(at);
    expect(out.phoneVerifiedAt).toBeNull();
    expect(out.buyer).toEqual({ name: "Jane", email: "j•••@example.com" });
    expect(out.items[0].user.contactEmail).toBe("s•••@example.com");
    expect(JSON.stringify(out)).not.toContain("7700900123");
  });

  it("leaves a missing value alone", () => {
    expect(maskContactDeep({ email: null, phone: undefined })).toEqual({ email: null, phone: undefined });
  });
});

describe("adminContactPrivacy", () => {
  function run(request: Partial<Request>) {
    const send = vi.fn();
    const response = { json: send } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    adminContactPrivacy({ body: {}, ...request } as Request, response, next);
    return { response, send, next: next as unknown as ReturnType<typeof vi.fn> };
  }

  it("masks GET responses", () => {
    const { response, send } = run({ method: "GET", path: "/users" });
    response.json({ items: [{ email: "jane@example.com" }] });
    expect(send).toHaveBeenCalledWith({ items: [{ email: "j•••@example.com" }] });
  });

  it("doesn't mask the admin team, so admins can manage each other", () => {
    const { response, send } = run({ method: "GET", path: "/admins" });
    response.json({ items: [{ email: "admin@example.com" }] });
    expect(send).toHaveBeenCalledWith({ items: [{ email: "admin@example.com" }] });
  });

  it("refuses a write that would save a masked value", () => {
    const { next } = run({ method: "PATCH", path: "/vendors/v1", body: { contactEmail: "s•••@example.com" } });
    expect(next.mock.calls[0][0]).toMatchObject({ code: "MASKED_VALUE_SUBMITTED" });
  });

  it("allows a write with a real value", () => {
    const { next } = run({ method: "PATCH", path: "/vendors/v1", body: { contactEmail: "new@example.com" } });
    expect(next).toHaveBeenCalledWith();
  });
});

describe("revealUserContact", () => {
  const call = (body: unknown) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const req = { user: { id: "admin1" }, params: { id: "u1" }, body, ip: "127.0.0.1" } as unknown as Request;
    return { promise: revealUserContact(req, res as unknown as Response), res };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    m.userFind.mockResolvedValue({ email: "jane@example.com", phone: "+447700900123", anonymisedAt: null });
    m.auditCreate.mockResolvedValue({});
  });

  it("needs a reason", async () => {
    await expect(call({}).promise).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    expect(m.auditCreate).not.toHaveBeenCalled();
  });

  it("records the audit, then returns the real value", async () => {
    const { promise, res } = call({ reason: "Delivery query from support" });
    await promise;
    expect(m.auditCreate.mock.calls[0][0].data).toMatchObject({ actorId: "admin1", action: "pii.reveal", entityType: "user", entityId: "u1", reason: "Delivery query from support" });
    expect(res.json).toHaveBeenCalledWith({ contact: { email: "jane@example.com", phone: "+447700900123" } });
  });

  it("reveals nothing if the audit can't be written", async () => {
    m.auditCreate.mockRejectedValue(new Error("database down"));
    const { promise, res } = call({ reason: "Delivery query from support" });
    await expect(promise).rejects.toThrow("database down");
    expect(res.json).not.toHaveBeenCalled();
  });

  it("has nothing to reveal for an anonymised account", async () => {
    m.userFind.mockResolvedValue({ email: "deleted@anonymized.local", phone: null, anonymisedAt: new Date() });
    const { promise, res } = call({ reason: "Delivery query from support" });
    await promise;
    expect(res.json).toHaveBeenCalledWith({ contact: { email: null, phone: null } });
  });
});

describe("campaign dispute hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.campaignFind.mockResolvedValue({ disputedAt: null });
    m.caseCount.mockResolvedValue(0);
  });

  it("allows release with no dispute and no open issue", async () => {
    await expect(assertNoCampaignDispute("c1")).resolves.toBeUndefined();
  });

  it("holds release while disputed", async () => {
    m.campaignFind.mockResolvedValue({ disputedAt: new Date() });
    expect(await campaignDisputeBlockers("c1")).toEqual(["campaign_disputed"]);
    await expect(assertNoCampaignDispute("c1")).rejects.toMatchObject({ code: "CAMPAIGN_DISPUTE_HOLD" });
  });

  it("holds release while a participant issue is open", async () => {
    m.caseCount.mockResolvedValue(1);
    expect(await campaignDisputeBlockers("c1")).toEqual(["open_participant_issue"]);
  });

  it("only counts issues about money, delivery or the supplier, and only open ones", async () => {
    await campaignDisputeBlockers("c1");
    const where = m.caseCount.mock.calls[0][0].where;
    expect(where.caseType.in).toEqual(["PAYMENT_ISSUE", "REFUND_ISSUE", "FULFILMENT_ISSUE", "SUPPLIER_CONDUCT", "PRODUCT_QUALITY"]);
    expect(where.status.in).toEqual(["OPEN", "IN_PROGRESS", "ESCALATED"]);
  });
});
