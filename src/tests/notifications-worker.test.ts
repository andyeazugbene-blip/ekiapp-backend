import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger", () => ({ logger: { info: vi.fn() } }));
vi.mock("../lib/redis", () => ({ getRedisConnection: vi.fn(() => null) }));
vi.mock("../modules/notifications/notifications.service", () => ({ notificationsService: { create: vi.fn() } }));

import { notificationsService } from "../modules/notifications/notifications.service";
import { processNotification } from "../workers/notifications.worker";

const create = vi.mocked(notificationsService.create);

beforeEach(() => vi.clearAllMocks());

describe("server notification worker", () => {
  it("preserves the dedupe key by using the shared notification creator", async () => {
    const input = {
      userId: "user-1",
      type: "ADMIN_BROADCAST" as const,
      title: "Notice",
      data: { destination: "admin_case" },
      dedupeKey: "INCIDENT:anomaly-1",
    };

    await processNotification({ id: "job-1", data: input } as never);

    expect(create).toHaveBeenCalledWith(input);
  });
});
