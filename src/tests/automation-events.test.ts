import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyAutomationAccountCreated, parseSignupAttribution } from "../lib/automation-events";

describe("automation account-created bridge", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.AUTOMATION_EVENTS_URL = "https://automation.test/api/attribution/events";
    process.env.AUTOMATION_WEBHOOK_SECRET = "s".repeat(32);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AUTOMATION_EVENTS_URL;
    delete process.env.AUTOMATION_WEBHOOK_SECRET;
  });

  it("posts a deduplicable registration event with the shared-secret header and no PII", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    await notifyAutomationAccountCreated({
      kind: "user_registered",
      userId: "user_1",
      role: "BUYER",
      country: "IT",
      signupMethod: "google",
      referred: true,
      attribution: { source: "instagram", campaign: "launch" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://automation.test/api/attribution/events");
    expect(init.headers["X-Eki-Webhook-Secret"]).toBe("s".repeat(32));
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      eventId: "eki:user:user_1:registered",
      eventType: "registration",
      leadId: "user_1",
      source: "instagram",
      campaignName: "launch",
      metadata: { kind: "user_registered", role: "BUYER", country: "IT", signupMethod: "google", referred: true },
    });
    for (const key of ["email", "phone", "name"]) {
      expect(body).not.toHaveProperty(key);
      expect(body.metadata).not.toHaveProperty(key);
    }
  });

  it("uses a vendor-scoped event id for store creation", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await notifyAutomationAccountCreated({ kind: "vendor_store_created", userId: "user_1", vendorId: "vendor_9", role: "VENDOR" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.eventId).toBe("eki:vendor:vendor_9:store_created");
    expect(body.vendorId).toBe("vendor_9");
  });

  it("is a no-op when not configured", async () => {
    delete process.env.AUTOMATION_WEBHOOK_SECRET;
    await notifyAutomationAccountCreated({ kind: "user_registered", userId: "u", role: "BUYER" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the Control Center is down or rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(notifyAutomationAccountCreated({ kind: "user_registered", userId: "u", role: "BUYER" })).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(notifyAutomationAccountCreated({ kind: "user_registered", userId: "u", role: "BUYER" })).resolves.toBeUndefined();
  });

  it("parses nested and flat UTM fields, trimming and capping length", () => {
    expect(parseSignupAttribution({ attribution: { source: " tiktok ", medium: "paid" } })).toEqual({ source: "tiktok", medium: "paid" });
    expect(parseSignupAttribution({ utm_source: "fb", utmCampaign: "x".repeat(200) })).toEqual({ source: "fb", campaign: "x".repeat(120) });
    expect(parseSignupAttribution({ utm_source: 5 })).toBeUndefined();
  });
});
