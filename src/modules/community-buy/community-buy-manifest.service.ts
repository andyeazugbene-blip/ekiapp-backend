import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { isDataAccessAllowed, recordDataAccess } from "./community-buy-privacy.service";

/**
 * M4 — supplier-facing manifest, in-app contact, and emergency-contact read
 * (spec §14.3, AT-39/AT-40/AT-41/AT-44). Same dual-path (legacy Vendor vs
 * SupplierAccount) shape as every other supplier-facing function in this
 * module — see campaign-fulfilment.service.ts's own requireSupplierOwned/
 * requireSupplierAccountOwned for the established precedent.
 *
 * Every function here re-resolves and re-checks capture status and
 * control_scope from the database on every call — nothing is cached from a
 * previous read, per spec's "re-check permissions on each action."
 */

interface ResolvedAccess {
  campaign: { id: string; deliveryPreference: string; deliveryResponsibility: string };
  accessorAccountId: string;
}

async function resolveForVendor(vendorId: string, campaignId: string): Promise<ResolvedAccess> {
  const supplier = await prisma.supplierProfile.findUnique({ where: { vendorId } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !supplier || campaign.supplierId !== supplier.id) throw new AppError("Campaign not found", 404);
  // The legacy Vendor-backed SupplierProfile has no controlScope concept
  // (that's SupplierAccount-only, spec §15.4) — isRestricted is the only
  // lever it has, and per spec's safer default a restriction with no scope
  // means revoke, so it maps straight to RESTRICTED with a null scope.
  const supplierState = supplier.isRestricted ? "RESTRICTED" : "APPROVED";
  if (!isDataAccessAllowed(supplierState, null)) {
    throw new AppError("Your supplier account's current status does not allow access to participant data for this campaign.", 403, undefined, "DATA_ACCESS_RESTRICTED");
  }
  return { campaign, accessorAccountId: supplier.id };
}

async function resolveForAccount(userId: string, campaignId: string): Promise<ResolvedAccess> {
  const account = await prisma.supplierAccount.findUnique({ where: { userId } });
  const campaign = await prisma.communityCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !account || campaign.supplierAccountId !== account.id) throw new AppError("Campaign not found", 404);
  if (!isDataAccessAllowed(account.supplierState, account.controlScope)) {
    throw new AppError("Your supplier account's current status does not allow access to participant data for this campaign.", 403, undefined, "DATA_ACCESS_RESTRICTED");
  }
  return { campaign, accessorAccountId: account.id };
}

async function buildManifest(access: ResolvedAccess, actorUserId: string) {
  // Capture-dependent (AT-39): only ever PAID contributions, never earlier
  // states. Deliberately no email/phone/address field anywhere in this
  // shape — participant reference (the existing opaque CampaignParticipant
  // id — already collision-proof and non-sequential, spec §16.2) + quantity
  // + delivery status only, matching AT-40's "no raw home addresses."
  const contributions = await prisma.campaignContribution.findMany({
    where: { campaignId: access.campaign.id, status: "PAID" },
    select: {
      id: true,
      participantId: true,
      quantity: true,
      deliveryReference: { select: { status: true, deliveryMethod: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const rows = contributions.map((c) => ({
    participantReference: c.participantId,
    contributionId: c.id,
    quantity: c.quantity,
    deliveryMethod: c.deliveryReference?.deliveryMethod ?? "COLLECTION",
    deliveryStatus: c.deliveryReference?.status ?? "NOT_REQUIRED",
  }));
  await recordDataAccess({
    campaignId: access.campaign.id,
    accessorAccountId: access.accessorAccountId,
    accessorUserId: actorUserId,
    accessorRole: "SUPPLIER",
    dataCategory: "MANIFEST",
    action: "VIEWED",
    purposeCode: "fulfilment_manifest",
  });
  return rows;
}

/**
 * Figma S25 "Prepare Home Deliveries" — the one supplier-facing read that
 * DOES expose a real home address/phone/instructions, deliberately kept
 * separate from buildManifest() above (which must never carry them —
 * see its own "no raw home addresses" comment) rather than adding an
 * optional field to the same shape, so a future caller of the manifest
 * can never accidentally receive PII by omitting a flag. Gated on the
 * real, persisted CommunityCampaign.deliveryResponsibility — SUPPLIER or
 * SHARED only; ORGANISER (the default) returns nothing here at all, same
 * 403 a mismatched campaign would give, not an empty-but-200 response
 * that would leak "this campaign exists and you're its supplier."
 */
async function buildFulfilmentDeliveries(access: ResolvedAccess, actorUserId: string) {
  if (access.campaign.deliveryPreference !== "DELIVERY" || access.campaign.deliveryResponsibility === "ORGANISER") {
    throw new AppError("You are not responsible for delivery on this campaign.", 403, undefined, "NOT_RESPONSIBLE_FOR_DELIVERY");
  }
  const contributions = await prisma.campaignContribution.findMany({
    where: { campaignId: access.campaign.id, status: "PAID" },
    select: {
      id: true,
      quantity: true,
      deliveryRecipientName: true,
      deliveryAddressLine1: true,
      deliveryAddressLine2: true,
      deliveryCity: true,
      deliveryPostcode: true,
      deliveryPhone: true,
      deliveryInstructions: true,
      deliveryReference: { select: { status: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  await recordDataAccess({
    campaignId: access.campaign.id,
    accessorAccountId: access.accessorAccountId,
    accessorUserId: actorUserId,
    accessorRole: "SUPPLIER",
    dataCategory: "ADDRESS_DETAIL",
    action: "VIEWED",
    purposeCode: "fulfilment_home_delivery",
  });
  return contributions.map((c) => ({
    contributionId: c.id,
    quantity: c.quantity,
    recipientName: c.deliveryRecipientName,
    addressLine1: c.deliveryAddressLine1,
    addressLine2: c.deliveryAddressLine2,
    city: c.deliveryCity,
    postcode: c.deliveryPostcode,
    phone: c.deliveryPhone,
    instructions: c.deliveryInstructions,
    deliveryStatus: c.deliveryReference?.status ?? "NOT_REQUIRED",
  }));
}

const MAX_MESSAGE_LENGTH = 1000;

async function sendContactMessage(access: ResolvedAccess, actorUserId: string, contributionId: string, channel: string, message: string | undefined) {
  if (channel !== "IN_APP_MESSAGE") {
    // No real protected-telephony/proxy provider or courier channel is
    // integrated (spec §26 — deliberately not invented here). In-app
    // messaging is the only tier of the contact hierarchy this milestone
    // can honestly deliver; everything else falls back to collection point.
    throw new AppError("This contact channel is not available yet — use in-app messaging or collection point.", 400, undefined, "CONTACT_CHANNEL_NOT_AVAILABLE");
  }
  if (typeof message !== "string" || !message.trim()) throw new AppError("message is required", 400);
  if (message.length > MAX_MESSAGE_LENGTH) throw new AppError(`message must be ${MAX_MESSAGE_LENGTH} characters or fewer`, 400);

  const contribution = await prisma.campaignContribution.findUnique({ where: { id: contributionId }, include: { participant: true } });
  if (!contribution || contribution.campaignId !== access.campaign.id || contribution.status !== "PAID") {
    throw new AppError("Contribution not found", 404);
  }

  await notificationsService.enqueue({
    userId: contribution.participant.userId,
    type: "COMMUNITY_CAMPAIGN_UPDATE",
    title: "Message from your supplier",
    body: message.trim(),
    data: { type: "community_campaign_update", event: "supplier_message", campaignId: access.campaign.id },
  });
  await recordDataAccess({
    campaignId: access.campaign.id,
    contributionId,
    participantId: contribution.participantId,
    accessorAccountId: access.accessorAccountId,
    accessorUserId: actorUserId,
    accessorRole: "SUPPLIER",
    dataCategory: "CONTACT_CHANNEL",
    action: "MESSAGE_SENT",
    purposeCode: "supplier_contact_message",
  });
  return { sent: true };
}

async function readEmergencyContact(access: ResolvedAccess, actorUserId: string, contributionId: string) {
  const contribution = await prisma.campaignContribution.findUnique({
    where: { id: contributionId },
    include: { participant: { include: { user: { select: { phone: true } } } } },
  });
  if (!contribution || contribution.campaignId !== access.campaign.id || contribution.status !== "PAID") {
    throw new AppError("Contribution not found", 404);
  }

  // Re-checked live on every read, per spec — a grant that has since
  // expired or been revoked is unusable even if it was valid moments ago.
  const grant = await prisma.communityBuyDataAccessLog.findFirst({
    where: {
      campaignId: access.campaign.id,
      contributionId,
      action: "ADMIN_OVERRIDE",
      dataCategory: "EMERGENCY_NUMBER",
      accessExpiresAt: { gt: new Date() },
      revokedAt: null,
    },
    orderBy: { accessedAt: "desc" },
  });
  if (!grant) {
    throw new AppError("No active emergency-disclosure grant for this participant.", 403, undefined, "EMERGENCY_ACCESS_NOT_GRANTED_OR_EXPIRED");
  }

  await recordDataAccess({
    campaignId: access.campaign.id,
    contributionId,
    participantId: contribution.participantId,
    accessorAccountId: access.accessorAccountId,
    accessorUserId: actorUserId,
    accessorRole: "SUPPLIER",
    dataCategory: "EMERGENCY_NUMBER",
    action: "VIEWED",
    purposeCode: "emergency_contact_view",
    accessExpiresAt: grant.accessExpiresAt,
    adminOverrideId: grant.adminOverrideId,
  });
  return { phone: contribution.participant.user.phone ?? null, accessExpiresAt: grant.accessExpiresAt };
}

export const communityBuyManifestService = {
  async getManifestForVendor(vendorId: string, campaignId: string, actorUserId: string) {
    const access = await resolveForVendor(vendorId, campaignId);
    return buildManifest(access, actorUserId);
  },
  async getManifestForAccount(userId: string, campaignId: string) {
    const access = await resolveForAccount(userId, campaignId);
    return buildManifest(access, userId);
  },

  async sendContactMessageForVendor(vendorId: string, campaignId: string, actorUserId: string, contributionId: string, channel: string, message: string | undefined) {
    const access = await resolveForVendor(vendorId, campaignId);
    return sendContactMessage(access, actorUserId, contributionId, channel, message);
  },
  async sendContactMessageForAccount(userId: string, campaignId: string, contributionId: string, channel: string, message: string | undefined) {
    const access = await resolveForAccount(userId, campaignId);
    return sendContactMessage(access, userId, contributionId, channel, message);
  },

  async getEmergencyContactForVendor(vendorId: string, campaignId: string, actorUserId: string, contributionId: string) {
    const access = await resolveForVendor(vendorId, campaignId);
    return readEmergencyContact(access, actorUserId, contributionId);
  },
  async getEmergencyContactForAccount(userId: string, campaignId: string, contributionId: string) {
    const access = await resolveForAccount(userId, campaignId);
    return readEmergencyContact(access, userId, contributionId);
  },

  async getFulfilmentDeliveriesForVendor(vendorId: string, campaignId: string, actorUserId: string) {
    const access = await resolveForVendor(vendorId, campaignId);
    return buildFulfilmentDeliveries(access, actorUserId);
  },
  async getFulfilmentDeliveriesForAccount(userId: string, campaignId: string) {
    const access = await resolveForAccount(userId, campaignId);
    return buildFulfilmentDeliveries(access, userId);
  },
};
