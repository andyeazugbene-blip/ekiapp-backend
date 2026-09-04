/**
 * Admin supplier-fulfilment delay queue (architecture doc §15.3). Real
 * findings derived from actual CampaignFulfilment rows — the primary
 * check uses the supplier's own real estimatedReadyAt date; the
 * no-progress fallback only ever fires when an admin has explicitly
 * configured FULFILMENT_STALE_THRESHOLD_HOURS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    campaignFulfilment: { findMany: vi.fn() },
    supplierFulfilmentAlert: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../config/env", () => ({
  env: { fulfilmentStaleThresholdHours: null as number | null },
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { notificationsService } from "../modules/notifications/notifications.service";
import { fulfilmentDelayService } from "../modules/community-buy/fulfilment-delay.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  m.campaignFulfilment.findMany.mockResolvedValue([] as never);
});

afterEach(() => {
  (env as unknown as { fulfilmentStaleThresholdHours: number | null }).fulfilmentStaleThresholdHours = null;
});

describe("fulfilmentDelayService.scan — PAST_ESTIMATED_READY_DATE (real business date)", () => {
  it("flags a fulfilment still not ready past its own real estimatedReadyAt", async () => {
    m.campaignFulfilment.findMany.mockResolvedValue([
      { campaignId: "camp-1", status: "PACKING", estimatedReadyAt: new Date(Date.now() - 2 * 60 * 60 * 1000), updatedAt: new Date(), createdAt: new Date() },
    ] as never);

    const result = await fulfilmentDelayService.scan();

    expect(result.found).toBe(1);
    expect(m.supplierFulfilmentAlert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: "PAST_ESTIMATED_READY_DATE:camp-1" },
        create: expect.objectContaining({ reason: "PAST_ESTIMATED_READY_DATE", campaignId: "camp-1" }),
      }),
    );
  });

  it("never flags a fulfilment whose estimatedReadyAt is still in the future", async () => {
    m.campaignFulfilment.findMany.mockResolvedValue([
      { campaignId: "camp-2", status: "PACKING", estimatedReadyAt: new Date(Date.now() + 2 * 60 * 60 * 1000), updatedAt: new Date(), createdAt: new Date() },
    ] as never);

    await fulfilmentDelayService.scan();

    expect(m.supplierFulfilmentAlert.upsert).not.toHaveBeenCalled();
  });
});

describe("fulfilmentDelayService.scan — STALE_NO_PROGRESS (configurable, no invented default)", () => {
  it("is a genuine no-op for a fulfilment with no estimatedReadyAt when no threshold is configured", async () => {
    m.campaignFulfilment.findMany.mockResolvedValue([
      { campaignId: "camp-3", status: "AWAITING_INVENTORY_CONFIRMATION", estimatedReadyAt: null, updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30), createdAt: new Date() },
    ] as never);

    const result = await fulfilmentDelayService.scan();

    expect(result.found).toBe(0);
    expect(result.staleCheckConfigured).toBe(false);
    expect(m.supplierFulfilmentAlert.upsert).not.toHaveBeenCalled();
  });

  it("flags real staleness once an admin configures the threshold", async () => {
    (env as unknown as { fulfilmentStaleThresholdHours: number | null }).fulfilmentStaleThresholdHours = 48;
    m.campaignFulfilment.findMany.mockResolvedValue([
      { campaignId: "camp-4", status: "AWAITING_INVENTORY_CONFIRMATION", estimatedReadyAt: null, updatedAt: new Date(Date.now() - 72 * 60 * 60 * 1000), createdAt: new Date() },
    ] as never);

    const result = await fulfilmentDelayService.scan();

    expect(result.staleCheckConfigured).toBe(true);
    expect(m.supplierFulfilmentAlert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dedupeKey: "STALE_NO_PROGRESS:camp-4" } }),
    );
  });

  it("does not flag a fulfilment updated recently, even with the threshold configured", async () => {
    (env as unknown as { fulfilmentStaleThresholdHours: number | null }).fulfilmentStaleThresholdHours = 48;
    m.campaignFulfilment.findMany.mockResolvedValue([
      { campaignId: "camp-5", status: "PACKING", estimatedReadyAt: null, updatedAt: new Date(), createdAt: new Date() },
    ] as never);

    await fulfilmentDelayService.scan();

    expect(m.supplierFulfilmentAlert.upsert).not.toHaveBeenCalled();
  });
});

describe("fulfilmentDelayService.contactSupplier — real notification, no auto-cancel/refund", () => {
  it("sends a real notification to the supplier's vendor user and marks the alert CONTACTED", async () => {
    m.supplierFulfilmentAlert.findUnique.mockResolvedValue({
      id: "alert-1", campaignId: "camp-1",
      campaign: { title: "Test Campaign", supplier: { vendor: { userId: "vendor-user-1" } } },
    } as never);
    m.supplierFulfilmentAlert.update.mockResolvedValue({ id: "alert-1", status: "CONTACTED" } as never);

    await fulfilmentDelayService.contactSupplier("alert-1", "admin-1", "Please update us on progress");

    expect(notificationsService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "vendor-user-1", body: expect.stringContaining("Please update us on progress") }),
    );
    expect(m.supplierFulfilmentAlert.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "alert-1" }, data: expect.objectContaining({ status: "CONTACTED" }) }),
    );
  });

  it("throws 404 for a missing alert and never sends a notification", async () => {
    m.supplierFulfilmentAlert.findUnique.mockResolvedValue(null);
    await expect(fulfilmentDelayService.contactSupplier("missing", "admin-1", "note")).rejects.toMatchObject({ statusCode: 404 });
    expect(notificationsService.enqueue).not.toHaveBeenCalled();
  });
});

describe("fulfilmentDelayService.escalate — status flag only", () => {
  it("only updates the alert's own status — never touches CampaignFulfilment/CommunityCampaign", async () => {
    m.supplierFulfilmentAlert.findUnique.mockResolvedValue({ id: "alert-2" } as never);
    m.supplierFulfilmentAlert.update.mockResolvedValue({ id: "alert-2", status: "ESCALATED" } as never);

    await fulfilmentDelayService.escalate("alert-2", "admin-1", "needs finance review");

    expect(m.supplierFulfilmentAlert.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "alert-2" }, data: expect.objectContaining({ status: "ESCALATED" }) }),
    );
    expect(m.campaignFulfilment.findMany).not.toHaveBeenCalled();
  });
});
