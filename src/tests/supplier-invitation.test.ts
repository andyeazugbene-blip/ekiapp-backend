import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    communityCampaign: { findUnique: vi.fn(), update: vi.fn() },
    supplierInvitation: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn() },
    supplierAccount: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("../lib/email-queue", () => ({
  enqueueEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../modules/notifications/notifications.service", () => ({
  notificationsService: { enqueue: vi.fn() },
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed-password") },
}));

import { prisma } from "../lib/prisma";
import { enqueueEmail } from "../lib/email-queue";
import { notificationsService } from "../modules/notifications/notifications.service";
import { supplierInvitationService } from "../modules/community-buy/supplier-invitation.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

const futureExpiry = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
const pastExpiry = new Date(Date.now() - 1000);

function baseInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    campaignId: "camp-1",
    invitedByUserId: "organiser-user-1",
    email: "invitee@example.com",
    token: "tok-abc",
    status: "PENDING",
    termsSnapshot: {},
    expiresAt: futureExpiry,
    respondedAt: null,
    acceptedSupplierAccountId: null,
    declineReason: null,
    campaign: { id: "camp-1", title: "Bulk rice buy", status: "LIVE", country: "GB", supplierId: null, supplierAccountId: null, organiser: { userId: "organiser-user-1" } },
    ...overrides,
  };
}

describe("supplierInvitationService.create — test E setup / L / M", () => {
  it("creates an invitation with a real token, expiry, and versioned terms snapshot; emails the invitee; audits the action", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "LIVE", title: "Bulk rice buy", minimumShares: 5, goalShares: 10, maximumShares: 15,
      pricePerShareMinor: 1000, currency: "GBP", deadline: futureExpiry, organiser: { userId: "organiser-user-1" },
    } as never);
    m.supplierInvitation.create.mockResolvedValue(baseInvitation() as never);
    m.user.findUnique.mockResolvedValue(null as never);

    const result = await supplierInvitationService.create("organiser-user-1", "camp-1", "Invitee@Example.com ");

    expect(m.supplierInvitation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        campaignId: "camp-1",
        invitedByUserId: "organiser-user-1",
        email: "invitee@example.com",
        termsSnapshot: expect.objectContaining({ title: "Bulk rice buy", pricePerShareMinor: 1000 }),
      }),
    }));
    expect(result.token).toBe("tok-abc");
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "invitee@example.com" }));
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "supplier_invitation.created", entityType: "SupplierInvitation" }),
    }));
  });

  it("notifies an existing Eki user in-app when the invited email already has an account", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({
      id: "camp-1", organiserId: "org-1", status: "LIVE", title: "Bulk rice buy", organiser: { userId: "organiser-user-1" },
    } as never);
    m.supplierInvitation.create.mockResolvedValue(baseInvitation() as never);
    m.user.findUnique.mockResolvedValue({ id: "existing-user-1" } as never);

    await supplierInvitationService.create("organiser-user-1", "camp-1", "invitee@example.com");

    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "existing-user-1", data: expect.objectContaining({ event: "supplier_invitation" }) }));
  });

  it("rejects a non-owning organiser", async () => {
    m.communityCampaign.findUnique.mockResolvedValue({ id: "camp-1", organiserId: "org-1", organiser: { userId: "someone-else" } } as never);
    await expect(supplierInvitationService.create("organiser-user-1", "camp-1", "a@b.com")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an invalid email", async () => {
    await expect(supplierInvitationService.create("organiser-user-1", "camp-1", "not-an-email")).rejects.toMatchObject({ statusCode: 400 });
    expect(m.communityCampaign.findUnique).not.toHaveBeenCalled();
  });
});

describe("supplierInvitationService.getByToken — expiry (test F)", () => {
  it("returns a PENDING invitation unchanged when not yet expired", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation() as never);
    const result = await supplierInvitationService.getByToken("tok-abc");
    expect(result.status).toBe("PENDING");
    expect(m.supplierInvitation.update).not.toHaveBeenCalled();
  });

  it("flips a PENDING invitation to EXPIRED once past its expiry, persisting the transition", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation({ expiresAt: pastExpiry }) as never);
    m.supplierInvitation.update.mockResolvedValue(baseInvitation({ expiresAt: pastExpiry, status: "EXPIRED" }) as never);
    const result = await supplierInvitationService.getByToken("tok-abc");
    expect(result.status).toBe("EXPIRED");
    expect(m.supplierInvitation.update).toHaveBeenCalledWith({ where: { id: "inv-1" }, data: { status: "EXPIRED" } });
  });

  it("404s for an unknown token", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(null as never);
    await expect(supplierInvitationService.getByToken("bad-token")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("supplierInvitationService.accept — test E, F, K", () => {
  it("creates a brand-new User + SupplierAccount for an invitee with no Eki account — never a Vendor (test E/K)", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation() as never);
    m.user.findUnique.mockResolvedValue(null as never);
    m.user.create.mockResolvedValue({ id: "new-user-1", email: "invitee@example.com" } as never);
    m.supplierAccount.findUnique.mockResolvedValue(null as never);
    m.supplierAccount.create.mockResolvedValue({ id: "acct-new-1", userId: "new-user-1", supplierState: "UNDER_REVIEW", legacySupplierProfileId: null } as never);
    m.supplierInvitation.update.mockResolvedValue(baseInvitation({ status: "ACCEPTED" }) as never);

    const result = await supplierInvitationService.accept("tok-abc", { name: "New Supplier", password: "hunter2hunter2" });

    expect(m.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: "invitee@example.com", name: "New Supplier", role: "BUYER" }),
    }));
    expect(m.user.create.mock.calls[0][0].data).not.toHaveProperty("vendor");
    expect(m.supplierAccount.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "new-user-1", supplierState: "UNDER_REVIEW" }),
    }));
    expect(result.assigned).toBe(false); // UNDER_REVIEW — not auto-assigned to the campaign yet (item 8)
    expect(m.vendor).toBeUndefined(); // no Vendor model mocked in this file at all — a Vendor call would throw
  });

  it("requires name and password when no account exists yet for the invited email", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation() as never);
    m.user.findUnique.mockResolvedValue(null as never);
    await expect(supplierInvitationService.accept("tok-abc")).rejects.toMatchObject({ statusCode: 400 });
    expect(m.user.create).not.toHaveBeenCalled();
  });

  it("links to an existing User's SupplierAccount when one already exists, without creating a new one", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation() as never);
    m.user.findUnique.mockResolvedValue({ id: "existing-user-1" } as never);
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-existing-1", userId: "existing-user-1", supplierState: "UNDER_REVIEW", legacySupplierProfileId: null } as never);
    m.supplierInvitation.update.mockResolvedValue(baseInvitation({ status: "ACCEPTED" }) as never);

    const result = await supplierInvitationService.accept("tok-abc");

    expect(m.supplierAccount.create).not.toHaveBeenCalled();
    expect(result.supplierAccountId).toBe("acct-existing-1");
  });

  it("immediately assigns the campaign when the accepting account is already APPROVED", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation() as never);
    m.user.findUnique.mockResolvedValue({ id: "approved-user-1" } as never);
    m.supplierAccount.findUnique.mockResolvedValue({ id: "acct-approved-1", userId: "approved-user-1", supplierState: "APPROVED", legacySupplierProfileId: null } as never);
    m.supplierInvitation.update.mockResolvedValue(baseInvitation({ status: "ACCEPTED" }) as never);
    m.communityCampaign.update.mockResolvedValue({ id: "camp-1", supplierAccountId: "acct-approved-1" } as never);

    const result = await supplierInvitationService.accept("tok-abc");

    expect(m.communityCampaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: expect.objectContaining({ supplierAccountId: "acct-approved-1", supplierCommitted: false }),
    });
    expect(result.assigned).toBe(true);
  });

  it("rejects accepting an already-DECLINED invitation", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation({ status: "DECLINED" }) as never);
    await expect(supplierInvitationService.accept("tok-abc")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects accepting an EXPIRED invitation with the INVITATION_EXPIRED code", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation({ expiresAt: pastExpiry }) as never);
    m.supplierInvitation.update.mockResolvedValue(baseInvitation({ expiresAt: pastExpiry, status: "EXPIRED" }) as never);
    await expect(supplierInvitationService.accept("tok-abc")).rejects.toMatchObject({ statusCode: 409, code: "INVITATION_EXPIRED" });
  });
});

describe("supplierInvitationService.decline — test F", () => {
  it("records the decline with a reason and notifies the organiser", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation() as never);
    m.supplierInvitation.update.mockResolvedValue(baseInvitation({ status: "DECLINED", declineReason: "Too busy" }) as never);

    const result = await supplierInvitationService.decline("tok-abc", "Too busy");

    expect(result.status).toBe("DECLINED");
    expect(m.supplierInvitation.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { status: "DECLINED", respondedAt: expect.any(Date), declineReason: "Too busy" },
    });
    expect(notificationsService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: "organiser-user-1" }));
  });

  it("rejects declining an already-ACCEPTED invitation", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue(baseInvitation({ status: "ACCEPTED" }) as never);
    await expect(supplierInvitationService.decline("tok-abc")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("supplierInvitationService.revoke", () => {
  it("lets the inviting organiser revoke a pending invitation", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue({ ...baseInvitation(), campaign: { organiser: { userId: "organiser-user-1" } } } as never);
    m.supplierInvitation.update.mockResolvedValue(baseInvitation({ status: "REVOKED" }) as never);
    const result = await supplierInvitationService.revoke("organiser-user-1", "inv-1");
    expect(result.status).toBe("REVOKED");
  });

  it("404s for a non-owning organiser", async () => {
    m.supplierInvitation.findUnique.mockResolvedValue({ ...baseInvitation(), campaign: { organiser: { userId: "someone-else" } } } as never);
    await expect(supplierInvitationService.revoke("organiser-user-1", "inv-1")).rejects.toMatchObject({ statusCode: 404 });
  });
});
