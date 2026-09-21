/**
 * Controller-level coverage for admin-platform-settings.controller.ts — the
 * request/response wiring layer between the real route (gated by the
 * already-extensively-tested requireAdminPermission("settings.read"/
 * "settings.mutate") + authenticate middleware, reused unchanged from
 * every other admin route) and adminPlatformSettingsService (its own
 * business logic already covered in admin-platform-settings.test.ts).
 * Proves: the controller itself refuses to act without a real
 * authenticated user (matching every other admin controller's
 * requireUserId() convention), and correctly extracts key/value/reason
 * from the real request before calling the service.
 */
import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./../modules/admin/admin-platform-settings.service", () => ({
  adminPlatformSettingsService: { list: vi.fn(), setValue: vi.fn() },
}));

import { adminPlatformSettingsService } from "../modules/admin/admin-platform-settings.service";
import { listOperationalThresholds, updateOperationalThreshold } from "../modules/admin/admin-platform-settings.controller";

function fakeResponse(): Response {
  const res: Partial<Response> = {};
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => vi.clearAllMocks());

describe("listOperationalThresholds", () => {
  it("returns the real settings list from the service, unauthenticated reads are already blocked upstream by requireAdminPermission", async () => {
    vi.mocked(adminPlatformSettingsService.list).mockResolvedValue([
      { key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 48, updatedById: "admin-1", updatedAt: new Date() },
    ] as never);
    const res = fakeResponse();

    await listOperationalThresholds({} as Request, res);

    expect(res.json).toHaveBeenCalledWith({ settings: expect.arrayContaining([expect.objectContaining({ key: "PRICE_APPROVAL_TIMEOUT_HOURS", value: 48 })]) });
  });
});

describe("updateOperationalThreshold", () => {
  it("401s when there is no authenticated user on the request — the same requireUserId() convention every other admin controller uses", async () => {
    const res = fakeResponse();
    await expect(updateOperationalThreshold({ user: undefined, params: { key: "PRICE_APPROVAL_TIMEOUT_HOURS" }, body: { value: 48 } } as unknown as Request, res)).rejects.toMatchObject({ statusCode: 401 });
    expect(adminPlatformSettingsService.setValue).not.toHaveBeenCalled();
  });

  it("passes the real authenticated admin id, url key param, body value, and trimmed reason through to the service unchanged", async () => {
    vi.mocked(adminPlatformSettingsService.setValue).mockResolvedValue({
      key: "PAYOUT_STUCK_THRESHOLD_HOURS", value: 72, updatedById: "admin-7", updatedAt: new Date(),
    } as never);
    const res = fakeResponse();
    const request = {
      user: { id: "admin-7" },
      params: { key: "PAYOUT_STUCK_THRESHOLD_HOURS" },
      body: { value: 72, reason: "  extending grace period  " },
    } as unknown as Request;

    await updateOperationalThreshold(request, res);

    expect(adminPlatformSettingsService.setValue).toHaveBeenCalledWith(
      "PAYOUT_STUCK_THRESHOLD_HOURS", 72, "admin-7", "extending grace period", request,
    );
    expect(res.json).toHaveBeenCalledWith({ setting: expect.objectContaining({ key: "PAYOUT_STUCK_THRESHOLD_HOURS", value: 72 }) });
  });

  it("passes undefined reason (not an empty string) when none is provided — the service must not audit a blank reason as if one was given", async () => {
    vi.mocked(adminPlatformSettingsService.setValue).mockResolvedValue({} as never);
    const res = fakeResponse();
    const request = { user: { id: "admin-1" }, params: { key: "PRICE_APPROVAL_TIMEOUT_HOURS" }, body: { value: 10 } } as unknown as Request;

    await updateOperationalThreshold(request, res);

    expect(adminPlatformSettingsService.setValue).toHaveBeenCalledWith("PRICE_APPROVAL_TIMEOUT_HOURS", 10, "admin-1", undefined, request);
  });

  it("surfaces whatever validation error the service throws (e.g. invalid value) rather than swallowing it", async () => {
    const { AppError } = await import("../shared/errors/app-error");
    vi.mocked(adminPlatformSettingsService.setValue).mockRejectedValue(new AppError("value must be a finite number greater than zero", 400));
    const res = fakeResponse();
    const request = { user: { id: "admin-1" }, params: { key: "PRICE_APPROVAL_TIMEOUT_HOURS" }, body: { value: -5 } } as unknown as Request;

    await expect(updateOperationalThreshold(request, res)).rejects.toMatchObject({ statusCode: 400 });
  });
});
