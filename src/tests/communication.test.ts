import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communicationTemplate: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    communicationLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../lib/email-queue", () => ({
  enqueueEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/expo-push", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: {
    create: vi.fn().mockResolvedValue(undefined),
  },
}));

import { enqueueEmail } from "../lib/email-queue";
import { sendPushToUser } from "../lib/expo-push";
import { notificationsService } from "../modules/notifications/notifications.service";
import { communicationService } from "../modules/communications/communication.service";

const mockEnqueueEmail = enqueueEmail as unknown as ReturnType<typeof vi.fn>;
const mockSendPush = sendPushToUser as unknown as ReturnType<typeof vi.fn>;
const mockNotificationCreate = notificationsService.create as unknown as ReturnType<typeof vi.fn>;

describe("communicationService.send — template variable interpolation", () => {
  beforeEach(() => {
    mockEnqueueEmail.mockClear();
  });

  it("interpolates a normal variable into title and body", async () => {
    await communicationService.send({
      eventKey: "welcome_buyer",
      recipientId: "buyer-1",
      recipientEmail: "buyer@example.com",
      variables: { name: "Amara" },
    });
    const html = mockEnqueueEmail.mock.calls[0][0].html as string;
    expect(html).toContain("Hi Amara,");
    expect(html).not.toContain("{{name}}");
  });

  it("never leaves a raw {{placeholder}} visible when a variable is missing", async () => {
    await communicationService.send({
      eventKey: "welcome_buyer",
      recipientId: "buyer-1",
      recipientEmail: "buyer@example.com",
      variables: {},
    });
    const html = mockEnqueueEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("{{");
    expect(html).not.toContain("}}");
  });

  it("escapes HTML special characters in a variable before embedding in the email body — a store/buyer name is real user input, not trusted markup", async () => {
    await communicationService.send({
      eventKey: "welcome_buyer",
      recipientId: "buyer-1",
      recipientEmail: "buyer@example.com",
      variables: { name: "<script>alert(1)</script>" },
    });
    const html = mockEnqueueEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles a very long variable value without truncation or crash", async () => {
    const longName = "A".repeat(5000);
    await communicationService.send({
      eventKey: "welcome_buyer",
      recipientId: "buyer-1",
      recipientEmail: "buyer@example.com",
      variables: { name: longName },
    });
    const html = mockEnqueueEmail.mock.calls[0][0].html as string;
    expect(html).toContain(longName);
  });

  it("treats an explicitly empty-string variable the same as missing — no raw placeholder, no literal 'null'/'undefined'", async () => {
    await communicationService.send({
      eventKey: "welcome_buyer",
      recipientId: "buyer-1",
      recipientEmail: "buyer@example.com",
      variables: { name: "" },
    });
    const html = mockEnqueueEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("{{name}}");
    expect(html).not.toContain("null");
    expect(html).not.toContain("undefined");
  });
});

/**
 * Status-truth regression: send() used to resolve void unconditionally —
 * "the promise didn't throw" was the only signal a caller had, which is
 * true even when the template is disabled/missing or every channel failed.
 * It now reports a real SendResult so callers like
 * automationService.scheduleAutomation() can record an honest
 * SENT/SUPPRESSED/FAILED outcome instead of always writing "SENT."
 */
describe("communicationService.send — real outcome reporting", () => {
  beforeEach(() => {
    mockEnqueueEmail.mockClear().mockResolvedValue(undefined);
    mockSendPush.mockClear().mockResolvedValue(undefined);
    mockNotificationCreate.mockClear().mockResolvedValue({ id: "notif-1" });
  });

  it("reports SUPPRESSED for a disabled/missing template — no channel is attempted", async () => {
    const result = await communicationService.send({
      eventKey: "no_such_template_key",
      recipientId: "buyer-1",
      variables: {},
    });
    expect(result).toEqual({ outcome: "SUPPRESSED", reason: expect.stringContaining("disabled or does not exist") });
    expect(mockEnqueueEmail).not.toHaveBeenCalled();
    expect(mockSendPush).not.toHaveBeenCalled();
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("skips the email channel gracefully when there's no recipientEmail, and still reports SENT via in_app", async () => {
    const result = await communicationService.send({
      eventKey: "welcome_buyer", // channels: ["email", "in_app"]
      recipientId: "buyer-1",
      variables: { name: "Test" },
    });
    expect(result.outcome).toBe("SENT");
    expect(mockEnqueueEmail).not.toHaveBeenCalled();
    expect(mockNotificationCreate).toHaveBeenCalled();
  });

  it("reports SUPPRESSED when an email-only template has no recipientEmail — no channel was structurally eligible to attempt", async () => {
    const { prisma } = await import("../lib/prisma");
    vi.mocked(prisma.communicationTemplate.findUnique).mockResolvedValueOnce({
      key: "email_only_test",
      title: "Test",
      body: "Test body",
      channels: ["email"],
      enabled: true,
      recipientType: "BUYER",
    } as never);

    const result = await communicationService.send({
      eventKey: "email_only_test",
      recipientId: "buyer-1",
      // no recipientEmail
      variables: {},
    });

    expect(result).toEqual({ outcome: "SUPPRESSED", reason: expect.stringContaining("No eligible channel") });
    expect(mockEnqueueEmail).not.toHaveBeenCalled();
  });

  it("reports SENT when at least one channel actually dispatches", async () => {
    const result = await communicationService.send({
      eventKey: "vendor_verification_approved", // channels: ["email", "push", "in_app"]
      recipientId: "vendor-user-1",
      recipientEmail: "vendor@example.com",
      variables: { store_name: "Test Store" },
    });
    expect(result).toEqual({ outcome: "SENT" });
  });

  it("reports FAILED (not SENT) when every channel actually fails to dispatch", async () => {
    mockEnqueueEmail.mockRejectedValue(new Error("SMTP down"));
    mockSendPush.mockRejectedValue(new Error("Expo unreachable"));
    mockNotificationCreate.mockRejectedValue(new Error("DB unavailable"));

    const result = await communicationService.send({
      eventKey: "vendor_verification_approved",
      recipientId: "vendor-user-1",
      recipientEmail: "vendor@example.com",
      variables: { store_name: "Test Store" },
    });

    expect(result).toEqual({ outcome: "FAILED", reason: expect.stringContaining("Every channel failed") });
  });

  it("still reports SENT when the in_app write is a benign dedupe (created === null), since the recipient is genuinely notified via the other write", async () => {
    mockNotificationCreate.mockResolvedValue(null); // dedupeKey collision — not an error
    const result = await communicationService.send({
      eventKey: "welcome_buyer",
      recipientId: "buyer-1",
      variables: { name: "Test" },
      dedupeKey: "already-used-key",
    });
    expect(result.outcome).toBe("SENT");
  });
});
