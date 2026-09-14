import crypto from "crypto";

import bcrypt from "bcryptjs";

import { prisma } from "../../lib/prisma";
import { enqueueEmail } from "../../lib/email-queue";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { notificationsService } from "../notifications/notifications.service";

/**
 * Community Buy Workstream 3 — mandate item 7, the third supply route
 * deferred from Workstream 2: an organiser invites someone by email who may
 * have no Eki account at all. Accepting creates/links a SupplierAccount
 * only — never a Vendor (explicit "do NOT create a fake retail Vendor"
 * instruction) — matching item 8's separation of account-level approval
 * from campaign-level acceptance: accepting an invitation links the
 * supplier to this campaign's *intent*, but only an already-APPROVED
 * account is actually attached to the campaign immediately; a brand-new
 * invitee's account starts UNDER_REVIEW like any other application and
 * needs the same admin approval as the picker path before assignment
 * completes, so "organiser cannot assign an unapproved supplier" (item 6/
 * test J) holds for this route too.
 */

const BCRYPT_ROUNDS = 12;
const INVITATION_EXPIRY_DAYS = 7;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";
const INVITATION_ACTOR_PREFIX = "supplier-invitation";

// Statuses in which inviting/being invited to supply still means something —
// mirrors community-campaigns.service.ts's SUPPLIER_RESPONSE_STATUSES
// (kept as a separate local copy rather than exported/shared, since the two
// lists are allowed to diverge and this avoids coupling two service files
// over a single small constant).
const INVITABLE_CAMPAIGN_STATUSES = ["DRAFT", "CHANGES_REQUIRED", "UNDER_REVIEW", "APPROVED", "LIVE", "PAUSED", "RESCUE_WINDOW"] as const;

async function notifyOrganiser(organiserUserId: string, event: string, title: string, body: string, campaignId: string): Promise<void> {
  try {
    await notificationsService.enqueue({
      userId: organiserUserId,
      type: "COMMUNITY_CAMPAIGN_UPDATE",
      title,
      body,
      data: { type: "community_campaign_update", event, campaignId, audience: "organiser" },
    });
  } catch (error) {
    logger.error("Supplier invitation notification failed (non-blocking)", { event, campaignId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

export const supplierInvitationService = {
  async create(organiserUserId: string, campaignId: string, email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) throw new AppError("A valid email is required", 400);

    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign || campaign.organiser.userId !== organiserUserId) throw new AppError("Campaign not found", 404);
    if (!(INVITABLE_CAMPAIGN_STATUSES as readonly string[]).includes(campaign.status)) {
      throw new AppError("This campaign can no longer accept a new supplier invitation", 409);
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    // Versioned snapshot — what the invitee is actually agreeing to, immune
    // to the organiser editing the campaign after the invite is sent.
    const termsSnapshot = {
      title: campaign.title,
      minimumShares: campaign.minimumShares,
      goalShares: campaign.goalShares,
      maximumShares: campaign.maximumShares,
      pricePerShareMinor: campaign.pricePerShareMinor,
      currency: campaign.currency,
      deadline: campaign.deadline,
    };

    const invitation = await prisma.supplierInvitation.create({
      data: { campaignId, invitedByUserId: organiserUserId, email: normalizedEmail, token, expiresAt, termsSnapshot },
    });

    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
    if (existingUser) {
      await notificationsService.enqueue({
        userId: existingUser.id,
        type: "COMMUNITY_CAMPAIGN_UPDATE",
        title: "You've been invited to supply a Community Buy campaign",
        body: `You've been invited to supply "${campaign.title}". Review and respond.`,
        data: { type: "community_campaign_update", event: "supplier_invitation", campaignId, invitationId: invitation.id, token: invitation.token },
      });
    }
    const acceptUrl = `${FRONTEND_URL}/supplier-invitations/${token}`;
    await enqueueEmail({
      to: normalizedEmail,
      subject: `You're invited to supply "${campaign.title}" on Eki`,
      html: `<p>An organiser on Eki has invited you to supply "${campaign.title}".</p><p><a href="${acceptUrl}">Review and respond</a></p><p>This invitation expires ${expiresAt.toDateString()}.</p>`,
    });

    await recordAudit({
      actorId: organiserUserId,
      action: "supplier_invitation.created",
      entityType: "SupplierInvitation",
      entityId: invitation.id,
      metadata: { campaignId, email: normalizedEmail },
    });

    return invitation;
  },

  async getByToken(token: string) {
    const invitation = await prisma.supplierInvitation.findUnique({
      where: { token },
      include: { campaign: { select: { id: true, title: true, status: true, country: true, supplierId: true, supplierAccountId: true, organiser: { select: { userId: true } } } } },
    });
    if (!invitation) throw new AppError("Invitation not found", 404);
    if (invitation.status === "PENDING" && invitation.expiresAt < new Date()) {
      const expired = await prisma.supplierInvitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
      return { ...invitation, ...expired };
    }
    return invitation;
  },

  async listForCampaign(organiserUserId: string, campaignId: string) {
    const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId }, include: { organiser: true } });
    if (!campaign || campaign.organiser.userId !== organiserUserId) throw new AppError("Campaign not found", 404);
    return prisma.supplierInvitation.findMany({ where: { campaignId }, orderBy: { createdAt: "desc" } });
  },

  async revoke(organiserUserId: string, invitationId: string) {
    const invitation = await prisma.supplierInvitation.findUnique({ where: { id: invitationId }, include: { campaign: { include: { organiser: true } } } });
    if (!invitation || invitation.campaign.organiser.userId !== organiserUserId) throw new AppError("Invitation not found", 404);
    if (invitation.status !== "PENDING") throw new AppError("Only a pending invitation can be revoked", 409);
    const updated = await prisma.supplierInvitation.update({ where: { id: invitationId }, data: { status: "REVOKED", respondedAt: new Date() } });
    await recordAudit({ actorId: organiserUserId, action: "supplier_invitation.revoked", entityType: "SupplierInvitation", entityId: invitationId });
    return updated;
  },

  /**
   * Accept — the core of item 7. `newUser` is required only when no Eki
   * account exists yet for the invited email; an existing user accepts by
   * token alone (no password needed — they're already authenticated
   * elsewhere, or this can be called pre-login since the token itself is
   * the proof of intent for a brand-new signup).
   */
  async accept(token: string, newUser?: { name: string; password: string }) {
    const invitation = await this.getByToken(token);
    if (invitation.status !== "PENDING") {
      throw new AppError("This invitation is no longer valid", 409, undefined, invitation.status === "EXPIRED" ? "INVITATION_EXPIRED" : "INVITATION_NOT_PENDING");
    }

    let user = await prisma.user.findUnique({ where: { email: invitation.email } });
    if (!user) {
      if (!newUser?.name?.trim() || !newUser?.password) {
        throw new AppError("name and password are required to create an account", 400);
      }
      const passwordHash = await bcrypt.hash(newUser.password, BCRYPT_ROUNDS);
      try {
        // Deliberately a plain User only — no Vendor, matching the mandate's
        // explicit "do NOT create a fake retail Vendor" instruction.
        user = await prisma.user.create({ data: { email: invitation.email, name: newUser.name.trim(), password: passwordHash, role: "BUYER" } });
      } catch (error: any) {
        if (error?.code === "P2002") throw new AppError("An account with this email already exists — log in and try again", 409);
        throw error;
      }
    }

    let account = await prisma.supplierAccount.findUnique({ where: { userId: user.id } });
    if (!account) {
      account = await prisma.supplierAccount.create({
        data: {
          userId: user.id,
          supplierState: "UNDER_REVIEW",
          coverageRegions: invitation.campaign.country ? [invitation.campaign.country] : [],
        },
      });
    }

    await prisma.supplierInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", respondedAt: new Date(), acceptedSupplierAccountId: account.id },
    });

    // Account-level approval stays independent of this campaign-level
    // acceptance (item 8) — only an already-approved account is attached to
    // the campaign now; a fresh UNDER_REVIEW account needs the same admin
    // approval as the picker path before an organiser can complete
    // assignment (via reassignSupplier, now that this account is eligible).
    let assigned = false;
    if (account.supplierState === "APPROVED" && !invitation.campaign.supplierAccountId) {
      await prisma.communityCampaign.update({
        where: { id: invitation.campaignId },
        data: {
          supplierAccountId: account.id,
          supplierId: account.legacySupplierProfileId ?? invitation.campaign.supplierId,
          supplierCommitted: false,
          supplierCommittedAt: null,
          supplierDeclinedAt: null,
          supplierDeclineReason: null,
        },
      });
      assigned = true;
    }

    await recordAudit({
      actorId: user.id,
      action: "supplier_invitation.accepted",
      entityType: "SupplierInvitation",
      entityId: invitation.id,
      metadata: { campaignId: invitation.campaignId, supplierAccountId: account.id, assigned },
    });

    await notifyOrganiser(
      invitation.campaign.organiser.userId,
      "supplier_invitation_accepted",
      "Supplier invitation accepted",
      assigned
        ? `Your invited supplier accepted and has been assigned to "${invitation.campaign.title}".`
        : `Your invited supplier accepted "${invitation.campaign.title}" and is now awaiting Eki's approval before they can be assigned.`,
      invitation.campaignId,
    );

    return { userId: user.id, supplierAccountId: account.id, supplierState: account.supplierState, assigned };
  },

  async decline(token: string, reason?: string) {
    const invitation = await this.getByToken(token);
    if (invitation.status !== "PENDING") {
      throw new AppError("This invitation is no longer valid", 409, undefined, invitation.status === "EXPIRED" ? "INVITATION_EXPIRED" : "INVITATION_NOT_PENDING");
    }
    const updated = await prisma.supplierInvitation.update({
      where: { id: invitation.id },
      data: { status: "DECLINED", respondedAt: new Date(), declineReason: reason?.trim() || null },
    });
    await recordAudit({
      actorId: `${INVITATION_ACTOR_PREFIX}:${invitation.email}`,
      action: "supplier_invitation.declined",
      entityType: "SupplierInvitation",
      entityId: invitation.id,
      reason,
    });
    await notifyOrganiser(
      invitation.campaign.organiser.userId,
      "supplier_invitation_declined",
      "Supplier invitation declined",
      reason ? `Your invited supplier declined: ${reason}` : `Your invited supplier declined to supply "${invitation.campaign.title}".`,
      invitation.campaignId,
    );
    return updated;
  },
};
