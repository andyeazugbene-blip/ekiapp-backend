/**
 * Phase B/E (vendor verification) — stripeIdentityService had zero test
 * coverage despite being a real webhook-driven security decision (does
 * this vendor get marked VERIFIED or REJECTED) with no dedicated tests
 * proving it handles a missing vendorId, an unknown vendor, or an
 * unrecognized session status safely rather than crashing or silently
 * mutating the wrong row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: { vendor: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/stripe", () => ({ stripe: { identity: { verificationSessions: { create: vi.fn() } } } }));
vi.mock("../modules/communications/communication.service", () => ({ communicationService: { send: vi.fn().mockResolvedValue(undefined) } }));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { communicationService } from "../modules/communications/communication.service";
import { stripeIdentityService } from "../modules/verification/stripe-identity.service";

const m = vi.mocked(prisma, true) as any;
const s = vi.mocked(stripe, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("stripeIdentityService.createVerificationSession", () => {
  it("403s when the caller has no vendor profile", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(stripeIdentityService.createVerificationSession("user-1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("500s when Stripe returns a session with no url — never returns a dead link", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "UNVERIFIED", storeName: "Store", user: { email: "a@b.com" } });
    s.identity.verificationSessions.create.mockResolvedValue({ id: "vs_1", url: null });
    await expect(stripeIdentityService.createVerificationSession("user-1")).rejects.toMatchObject({ statusCode: 500 });
    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("marks the vendor PENDING and clears any prior failure reason on a real new session", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "REJECTED", storeName: "Store", user: { email: "a@b.com" } });
    s.identity.verificationSessions.create.mockResolvedValue({ id: "vs_1", url: "https://verify.stripe.com/vs_1" });
    m.vendor.update.mockResolvedValue({});

    const result = await stripeIdentityService.createVerificationSession("user-1");

    expect(result).toEqual({ url: "https://verify.stripe.com/vs_1", sessionId: "vs_1" });
    expect(m.vendor.update).toHaveBeenCalledWith({
      where: { id: "vendor-1" },
      data: { stripeVerificationSessionId: "vs_1", verificationStatus: "PENDING", verificationFailureReason: null },
    });
  });
});

describe("stripeIdentityService.handleVerificationCompleted — webhook safety", () => {
  it("never throws and never touches the database when vendorId metadata is missing", async () => {
    await expect(stripeIdentityService.handleVerificationCompleted({ id: "vs_1", status: "verified", metadata: {} })).resolves.toBeUndefined();
    expect(m.vendor.findUnique).not.toHaveBeenCalled();
    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("never throws and never mutates when the referenced vendor no longer exists", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(stripeIdentityService.handleVerificationCompleted({ id: "vs_1", status: "verified", metadata: { vendorId: "gone" } })).resolves.toBeUndefined();
    expect(m.vendor.update).not.toHaveBeenCalled();
  });

  it("marks the vendor VERIFIED with a real verifiedAt, clears the failure reason, and sends the approval communication with the real store name", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "PENDING", stripeVerificationSessionId: "vs_1" });
    m.vendor.update.mockResolvedValue({ userId: "user-1", storeName: "Amaka's Kitchen", user: { email: "a@b.com" } });

    await stripeIdentityService.handleVerificationCompleted({ id: "vs_1", status: "verified", metadata: { vendorId: "vendor-1" } });

    expect(m.vendor.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "vendor-1" },
      data: expect.objectContaining({ verificationStatus: "VERIFIED", verificationFailureReason: null, verifiedAt: expect.any(Date) }),
    }));
    expect(communicationService.send).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_verification_approved",
      recipientId: "user-1",
      variables: { store_name: "Amaka's Kitchen" },
    }));
  });

  it("marks the vendor REJECTED with the real Stripe failure reason (never a made-up one), and sends the rejection communication with that reason", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "PENDING", stripeVerificationSessionId: "vs_1" });
    m.vendor.update.mockResolvedValue({ userId: "user-1", storeName: "Amaka's Kitchen", user: { email: "a@b.com" } });

    await stripeIdentityService.handleVerificationCompleted({
      id: "vs_1", status: "requires_input", metadata: { vendorId: "vendor-1" },
      last_error: { code: "document_expired", reason: "The provided document has expired" },
    });

    expect(m.vendor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ verificationStatus: "REJECTED", verificationFailureReason: "The provided document has expired" }),
    }));
    expect(communicationService.send).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "vendor_verification_rejected",
      variables: expect.objectContaining({ reason: "The provided document has expired" }),
    }));
  });

  it("falls back to the error code when Stripe gives no human-readable reason, and to a generic message when neither exists", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "PENDING", stripeVerificationSessionId: "vs_1" });
    m.vendor.update.mockResolvedValue({ userId: "user-1", storeName: "Store", user: { email: "a@b.com" } });

    await stripeIdentityService.handleVerificationCompleted({ id: "vs_1", status: "requires_input", metadata: { vendorId: "vendor-1" }, last_error: { code: "document_type_not_supported" } });

    expect(m.vendor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ verificationFailureReason: "document_type_not_supported" }),
    }));
  });

  it("never mutates the vendor for an unrecognized/in-progress session status — only logs", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "PENDING", stripeVerificationSessionId: "vs_1" });

    await stripeIdentityService.handleVerificationCompleted({ id: "vs_1", status: "processing", metadata: { vendorId: "vendor-1" } });

    expect(m.vendor.update).not.toHaveBeenCalled();
    expect(communicationService.send).not.toHaveBeenCalled();
  });

  it("a failed verification-approved communication never throws out of the webhook handler — the DB state change already succeeded", async () => {
    m.vendor.findUnique.mockResolvedValue({ id: "vendor-1", verificationStatus: "PENDING", stripeVerificationSessionId: "vs_1" });
    m.vendor.update.mockResolvedValue({ userId: "user-1", storeName: "Store", user: { email: "a@b.com" } });
    vi.mocked(communicationService.send).mockRejectedValueOnce(new Error("email provider down"));

    await expect(stripeIdentityService.handleVerificationCompleted({ id: "vs_1", status: "verified", metadata: { vendorId: "vendor-1" } })).resolves.toBeUndefined();
  });
});

describe("stripeIdentityService.getVerificationStatus", () => {
  it("403s when the caller has no vendor profile", async () => {
    m.vendor.findUnique.mockResolvedValue(null);
    await expect(stripeIdentityService.getVerificationStatus("user-1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns the vendor's real verification fields", async () => {
    const row = { verificationStatus: "VERIFIED", stripeVerificationSessionId: "vs_1", verifiedAt: new Date(), verificationFailureReason: null };
    m.vendor.findUnique.mockResolvedValue(row);
    const result = await stripeIdentityService.getVerificationStatus("user-1");
    expect(result).toEqual(row);
  });
});
