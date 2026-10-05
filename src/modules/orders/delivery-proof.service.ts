import type { OrderEvidenceKind, OrderEvidenceRole } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { attachUploadAsset, signedReadFor } from "../disputes/dispute-v2.service";
import { eventsService, EVENT_NAMES } from "../events/events.service";

/** Handbook §11 L453: delivery or pickup evidence is attached to the order and access-controlled. */
export const DELIVERY_PROOF_ORDER_STATUSES = ["DISPATCHED", "IN_TRANSIT", "DELIVERED"] as const;
const KINDS = ["DELIVERY_PHOTO", "PICKUP_CONFIRMATION", "SIGNATURE", "NOTE"] as const;

async function render(orderId: string) {
  const rows = await prisma.orderEvidence.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  return Promise.all(rows.map(async (r) => {
    return { ...r, ...(await signedReadFor(r.uploadAssetId)) };
  }));
}

export const deliveryProofService = {
  async addAsVendor(userId: string, orderId: string, input: { kind?: unknown; uploadAssetId?: unknown; note?: unknown }) {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, vendorId: true, status: true } });
    if (!order || order.vendorId !== vendor.id) throw new AppError("Order not found", 404);
    if (!(DELIVERY_PROOF_ORDER_STATUSES as readonly string[]).includes(order.status)) {
      throw new AppError("Delivery proof can only be added once the order is dispatched", 409);
    }
    const kind = String(input.kind ?? "").toUpperCase() as OrderEvidenceKind;
    if (!(KINDS as readonly string[]).includes(kind)) throw new AppError(`kind must be one of ${KINDS.join(", ")}`, 400);
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 1000) : null;
    let uploadAssetId: string | null = null;
    if (kind === "NOTE") {
      if (!note || note.length < 5) throw new AppError("A note of at least 5 characters is required", 400);
    } else if (kind !== "PICKUP_CONFIRMATION" || input.uploadAssetId) {
      if (typeof input.uploadAssetId !== "string" || !input.uploadAssetId) throw new AppError("uploadAssetId is required", 400);
      await attachUploadAsset(userId, input.uploadAssetId, "delivery_proof", "order", orderId);
      uploadAssetId = input.uploadAssetId;
    } else if (!note) {
      throw new AppError("Provide a note or a file for the pickup confirmation", 400);
    }
    const created = await prisma.orderEvidence.create({
      data: { orderId, kind, uploadAssetId, note, submittedById: userId, submitterRole: "VENDOR" as OrderEvidenceRole },
    });
    eventsService.emit({
      name: EVENT_NAMES.delivery_proof_submitted, actorType: "vendor", actorId: userId, entityType: "Order", entityId: orderId,
      secondaryEntities: { evidenceId: created.id, vendorId: vendor.id }, source: "api",
      payload: { eventKey: `delivery_proof_submitted:${created.id}`, kind, hasFile: !!uploadAssetId },
    });
    return created;
  },

  async listForVendor(userId: string, orderId: string) {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    const order = vendor ? await prisma.order.findUnique({ where: { id: orderId }, select: { vendorId: true } }) : null;
    if (!vendor || !order || order.vendorId !== vendor.id) throw new AppError("Order not found", 404);
    return render(orderId);
  },

  async listForBuyer(userId: string, orderId: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { buyerId: true } });
    if (!order || order.buyerId !== userId) throw new AppError("Order not found", 404);
    return render(orderId);
  },

  /** Admin read (permission enforced by the order-detail endpoint). */
  listForAdmin(orderId: string) {
    return render(orderId);
  },
};
