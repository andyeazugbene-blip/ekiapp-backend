/**
 * Handoff CB-18 "capture.pending_review". Notification-only — must never
 * touch the authorisation row or call Stripe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityBuyPaymentAuthorisation: { findMany: vi.fn() },
  },
}));

const mockEnqueue = vi.fn().mockResolvedValue(undefined);
vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: (...a: unknown[]) => mockEnqueue(...a) },
}));

const mockAlertOps = vi.fn().mockResolvedValue(undefined);
vi.mock("../modules/community-buy/ops-alert.service", () => ({
  alertOps: (...a: unknown[]) => mockAlertOps(...a),
}));

import { prisma } from "../lib/prisma";
import { capturePendingReviewService } from "../modules/community-buy/capture-pending-review.service";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnqueue.mockResolvedValue(undefined);
  mockAlertOps.mockResolvedValue(undefined);
});

describe("capturePendingReviewService.runSweep", () => {
  it("does nothing when no authorisation is stuck", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    const result = await capturePendingReviewService.runSweep();
    expect(result.notified).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockAlertOps).not.toHaveBeenCalled();
  });

  it("sends the required exact wording to every stuck authorisation's buyer, and alerts ops once for the batch", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "auth-1", campaignId: "camp-1", contribution: { participant: { userId: "buyer-1" } } },
      { id: "auth-2", campaignId: "camp-1", contribution: { participant: { userId: "buyer-2" } } },
    ]);

    const result = await capturePendingReviewService.runSweep();

    expect(result.notified).toBe(2);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "buyer-1", body: "Payment under review. Do not pay again." }));
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "buyer-2", body: "Payment under review. Do not pay again." }));
    expect(mockAlertOps).toHaveBeenCalledTimes(1);
  });

  it("only ever queries CAPTURE_PENDING — never reads/writes anything else about the authorisation", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([]);
    await capturePendingReviewService.runSweep();
    expect(m.communityBuyPaymentAuthorisation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { captureStatus: "CAPTURE_PENDING" } }),
    );
  });

  it("a single failed notification send does not stop the others, and still counts them correctly", async () => {
    m.communityBuyPaymentAuthorisation.findMany.mockResolvedValue([
      { id: "auth-1", campaignId: "camp-1", contribution: { participant: { userId: "buyer-1" } } },
      { id: "auth-2", campaignId: "camp-1", contribution: { participant: { userId: "buyer-2" } } },
    ]);
    mockEnqueue.mockRejectedValueOnce(new Error("push failed")).mockResolvedValueOnce(undefined);

    const result = await capturePendingReviewService.runSweep();

    expect(result.notified).toBe(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });
});
