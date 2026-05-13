import type { DeliveryMethod, DeliveryZone } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreateDeliveryMethodInput,
  CreateDeliveryZoneInput,
  UpdateDeliveryMethodInput,
  UpdateDeliveryZoneInput,
} from "./delivery-zones.types";

type ZoneWithMethods = DeliveryZone & { deliveryMethods: DeliveryMethod[] };

export const deliveryZonesService = {
  // ─── Public ──────────────────────────────────────────────────────────────────

  async listActiveZones(): Promise<ZoneWithMethods[]> {
    return prisma.deliveryZone.findMany({
      where: { isActive: true },
      include: { deliveryMethods: { where: { isActive: true }, orderBy: { priceAmount: "asc" } } },
      orderBy: { country: "asc" },
    });
  },

  // ─── Vendor ──────────────────────────────────────────────────────────────────

  async listVendorZones(userId: string): Promise<ZoneWithMethods[]> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    return prisma.deliveryZone.findMany({
      where: { vendorId: vendor.id },
      include: { deliveryMethods: { orderBy: { priceAmount: "asc" } } },
      orderBy: { country: "asc" },
    });
  },

  async createVendorZone(userId: string, input: CreateDeliveryZoneInput): Promise<DeliveryZone> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    return prisma.deliveryZone.create({
      data: {
        vendorId: vendor.id,
        name: input.name,
        country: input.country,
        flag: input.flag,
        baseFeeAmount: input.baseFeeAmount,
        feePerKgAmount: input.feePerKgAmount,
        currency: input.currency ?? env.defaultCurrency,
        isActive: input.isActive ?? true,
      },
    });
  },

  async updateVendorZone(
    userId: string,
    zoneId: string,
    input: UpdateDeliveryZoneInput,
  ): Promise<DeliveryZone> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const zone = await prisma.deliveryZone.findUnique({ where: { id: zoneId } });
    if (!zone) throw new AppError("Delivery zone not found", 404);
    if (zone.vendorId !== vendor.id) throw new AppError("Forbidden", 403);

    return prisma.deliveryZone.update({ where: { id: zoneId }, data: input });
  },

  async deleteVendorZone(userId: string, zoneId: string): Promise<void> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const zone = await prisma.deliveryZone.findUnique({ where: { id: zoneId } });
    if (!zone) throw new AppError("Delivery zone not found", 404);
    if (zone.vendorId !== vendor.id) throw new AppError("Forbidden", 403);

    await prisma.deliveryZone.delete({ where: { id: zoneId } });
  },

  // ─── Delivery Methods ────────────────────────────────────────────────────────

  async addMethod(
    userId: string,
    zoneId: string,
    input: CreateDeliveryMethodInput,
  ): Promise<DeliveryMethod> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const zone = await prisma.deliveryZone.findUnique({ where: { id: zoneId } });
    if (!zone) throw new AppError("Delivery zone not found", 404);
    if (zone.vendorId !== vendor.id) throw new AppError("Forbidden", 403);

    if (input.minDays > input.maxDays) {
      throw new AppError("minDays cannot exceed maxDays", 400);
    }

    return prisma.deliveryMethod.create({
      data: {
        deliveryZoneId: zoneId,
        label: input.label,
        priceAmount: input.priceAmount,
        minDays: input.minDays,
        maxDays: input.maxDays,
        isActive: input.isActive ?? true,
      },
    });
  },

  async updateMethod(
    userId: string,
    methodId: string,
    input: UpdateDeliveryMethodInput,
  ): Promise<DeliveryMethod> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const method = await prisma.deliveryMethod.findUnique({
      where: { id: methodId },
      include: { deliveryZone: { select: { vendorId: true } } },
    });
    if (!method) throw new AppError("Delivery method not found", 404);
    if (method.deliveryZone.vendorId !== vendor.id) throw new AppError("Forbidden", 403);

    return prisma.deliveryMethod.update({ where: { id: methodId }, data: input });
  },

  async deleteMethod(userId: string, methodId: string): Promise<void> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const method = await prisma.deliveryMethod.findUnique({
      where: { id: methodId },
      include: { deliveryZone: { select: { vendorId: true } } },
    });
    if (!method) throw new AppError("Delivery method not found", 404);
    if (method.deliveryZone.vendorId !== vendor.id) throw new AppError("Forbidden", 403);

    await prisma.deliveryMethod.delete({ where: { id: methodId } });
  },
};
