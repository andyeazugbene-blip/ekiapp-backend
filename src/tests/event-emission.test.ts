import { beforeEach, describe, expect, it, vi } from "vitest";

const { emit } = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("../modules/events/events.service", async () => {
  const actual = await vi.importActual<typeof import("../modules/events/events.service")>("../modules/events/events.service");
  return { ...actual, eventsService: { ...actual.eventsService, emit } };
});
vi.mock("../lib/prisma", () => ({
  prisma: { subscriptionActionHistory: { create: vi.fn().mockResolvedValue({}) } },
}));

import { recordAction } from "../modules/regular-deliveries/buyer-subscriptions.service";
import { EVENT_NAMES } from "../modules/events/events.service";

beforeEach(() => emit.mockClear());

describe("subscription lifecycle -> canonical events", () => {
  const cases: Array<[string, string]> = [
    ["created", EVENT_NAMES.subscription_created],
    ["paused", EVENT_NAMES.subscription_paused],
    ["admin_paused", EVENT_NAMES.subscription_paused],
    ["resumed", EVENT_NAMES.subscription_resumed],
    ["admin_resumed", EVENT_NAMES.subscription_resumed],
    ["cancelled", EVENT_NAMES.subscription_cancelled],
    ["admin_cancelled", EVENT_NAMES.subscription_cancelled],
    ["skipped_next", EVENT_NAMES.subscription_skipped],
    ["admin_skipped_next", EVENT_NAMES.subscription_skipped],
  ];
  for (const [action, name] of cases) {
    it(`${action} emits ${name}`, async () => {
      await recordAction("sub-1", action, "user-1");
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name, entityType: "BuyerSubscription", entityId: "sub-1", actorId: "user-1" }));
    });
  }

  it("a non-lifecycle action (e.g. edited) emits nothing", async () => {
    await recordAction("sub-1", "edited", "user-1");
    expect(emit).not.toHaveBeenCalled();
  });

  it("system-initiated actions have actorType system", async () => {
    await recordAction("sub-1", "auto_resumed");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ actorType: "system", actorId: null }));
  });
});
