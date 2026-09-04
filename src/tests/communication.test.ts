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
import { communicationService } from "../modules/communications/communication.service";

const mockEnqueueEmail = enqueueEmail as unknown as ReturnType<typeof vi.fn>;

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
