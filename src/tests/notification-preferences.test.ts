/**
 * GET/PATCH /api/notifications/preferences — marketing consent.
 *
 * marketingConsentAt gates CART_RECOVERY / BUYER_WIN_BACK / BUYER_REFERRAL
 * / REVIEW_REQUEST in automation.service.ts's isEligible() (see
 * automation.test.ts) — until this endpoint existed, nothing in the
 * product could ever set that field, so those four automation types could
 * never fire for any buyer. This reuses the exact same authenticated
 * grant/revoke pattern already established for smsMarketingConsentAt, and
 * defaults to no consent (never a default opt-in).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { prisma } from "../lib/prisma";
import { getNotificationPreferences, updateNotificationPreferences } from "../modules/notifications/notifications.controller";

const m = vi.mocked(prisma, true);

function createMockReq(body: Record<string, unknown> = {}): Request {
  return { user: { id: "buyer-1", role: "BUYER", email: "buyer@test.com" }, body, headers: {}, ip: "127.0.0.1" } as unknown as Request;
}

function createMockRes(): Response & { statusCode: number; data: unknown } {
  const res = {
    statusCode: 0,
    data: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.data = data; return res; },
  };
  return res as unknown as Response & { statusCode: number; data: unknown };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.auditLog.create.mockResolvedValue({} as never);
});

describe("GET /notifications/preferences", () => {
  it("defaults to no marketing consent for a buyer who has never granted it", async () => {
    m.user.findUniqueOrThrow.mockResolvedValue({ smsMarketingConsentAt: null, smsTransactionalEnabled: false, marketingConsentAt: null } as never);
    const res = createMockRes();
    await getNotificationPreferences(createMockReq(), res as unknown as Response);
    expect((res.data as Record<string, unknown>).marketingConsent).toBe(false);
  });
});

describe("PATCH /notifications/preferences — marketingConsent", () => {
  it("rejects a non-boolean value", async () => {
    const res = createMockRes();
    await expect(
      updateNotificationPreferences(createMockReq({ marketingConsent: "yes" }), res as unknown as Response),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(m.user.update).not.toHaveBeenCalled();
  });

  it("grants consent: sets marketingConsentAt, returns true, and records an audit entry with before/after state", async () => {
    m.user.findUniqueOrThrow.mockResolvedValue({ smsMarketingConsentAt: null, smsTransactionalEnabled: false, marketingConsentAt: null } as never);
    const grantedAt = new Date("2026-09-05T12:00:00.000Z");
    m.user.update.mockResolvedValue({ smsMarketingConsentAt: null, smsTransactionalEnabled: false, marketingConsentAt: grantedAt } as never);

    const res = createMockRes();
    await updateNotificationPreferences(createMockReq({ marketingConsent: true }), res as unknown as Response);

    expect((res.data as Record<string, unknown>).marketingConsent).toBe(true);
    expect(m.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "buyer-1" },
      data: expect.objectContaining({ marketingConsentAt: expect.any(Date) }),
    }));
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: "buyer-1",
        action: "user.marketing_consent.granted",
        entityType: "User",
        entityId: "buyer-1",
        beforeState: { marketingConsentAt: null },
        afterState: { marketingConsentAt: grantedAt },
      }),
    }));
  });

  it("revokes consent: clears marketingConsentAt back to null and records the revoke", async () => {
    const previouslyGrantedAt = new Date("2026-09-01T00:00:00.000Z");
    m.user.findUniqueOrThrow.mockResolvedValue({ smsMarketingConsentAt: null, smsTransactionalEnabled: false, marketingConsentAt: previouslyGrantedAt } as never);
    m.user.update.mockResolvedValue({ smsMarketingConsentAt: null, smsTransactionalEnabled: false, marketingConsentAt: null } as never);

    const res = createMockRes();
    await updateNotificationPreferences(createMockReq({ marketingConsent: false }), res as unknown as Response);

    expect((res.data as Record<string, unknown>).marketingConsent).toBe(false);
    expect(m.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ marketingConsentAt: null }),
    }));
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "user.marketing_consent.revoked",
        beforeState: { marketingConsentAt: previouslyGrantedAt },
        afterState: { marketingConsentAt: null },
      }),
    }));
  });

  it("leaves marketingConsentAt untouched and skips the audit entry when the field isn't included in the request at all", async () => {
    m.user.update.mockResolvedValue({ smsMarketingConsentAt: new Date(), smsTransactionalEnabled: false, marketingConsentAt: null } as never);

    const res = createMockRes();
    await updateNotificationPreferences(createMockReq({ smsMarketing: true }), res as unknown as Response);

    expect(m.user.findUniqueOrThrow).not.toHaveBeenCalled(); // no "before" fetch needed
    expect(m.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ marketingConsentAt: expect.anything() }),
    }));
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });
});
