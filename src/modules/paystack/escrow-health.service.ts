import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { sendEmail } from "../../lib/email";
import { isSmsConfigured } from "../../lib/sms";
import { AppError } from "../../shared/errors/app-error";

const OPS_ALERT_EMAIL = process.env.OPS_ALERT_EMAIL ?? "";

export const escrowHealthService = {
  /**
   * Get the current escrow health: outstanding amounts vs expected balance.
   */
  async getHealth(): Promise<{
    outstandingOrders: number;
    outstandingAmount: number;
    currency: string;
    statusBreakdown: Record<string, { count: number; amount: number }>;
    smsConfigured: boolean;
    providers: Array<{
      country: string;
      countryCode: string;
      currency: string;
      provider: string;
      enabled: boolean;
      payoutSupported: boolean;
      otpChannel: string;
      protectionWindowHours: number;
    }>;
  }> {
    // Sum all escrow orders that haven't been released/refunded yet
    const activeStatuses = ["PAYMENT_SECURED", "VENDOR_CONFIRMED", "DISPATCHED", "DISPUTED"];

    const orders = await prisma.order.findMany({
      where: {
        escrowType: "DOMESTIC_AFRICA",
        status: { in: activeStatuses as any },
      },
      select: { status: true, totalAmount: true, currency: true },
    });

    let totalAmount = 0;
    const breakdown: Record<string, { count: number; amount: number }> = {};

    for (const order of orders) {
      totalAmount += order.totalAmount;
      if (!breakdown[order.status]) {
        breakdown[order.status] = { count: 0, amount: 0 };
      }
      breakdown[order.status].count++;
      breakdown[order.status].amount += order.totalAmount;
    }

    const providers = await prisma.escrowProviderConfig.findMany({
      orderBy: [{ enabled: "desc" }, { country: "asc" }],
      select: {
        country: true,
        countryCode: true,
        currency: true,
        provider: true,
        enabled: true,
        payoutSupported: true,
        otpChannel: true,
        protectionWindowHours: true,
      },
    });

    return {
      outstandingOrders: orders.length,
      outstandingAmount: totalAmount,
      currency: orders[0]?.currency ?? "NGN",
      statusBreakdown: breakdown,
      smsConfigured: isSmsConfigured(),
      providers,
    };
  },

  /**
   * Background check: alert ops if outstanding amount exceeds a threshold.
   * Called by the balance monitoring worker.
   */
  async checkAndAlert(): Promise<void> {
    const health = await this.getHealth();

    if (health.outstandingOrders === 0) return;

    // Log for monitoring
    logger.info("Escrow health check", {
      outstandingOrders: health.outstandingOrders,
      outstandingAmount: health.outstandingAmount,
      currency: health.currency,
    });

    // Alert if outstanding is significant (threshold: 10 orders or >500k in local currency)
    const AMOUNT_THRESHOLD = 50000000; // 500,000 in kobo = ₦500k
    const ORDER_THRESHOLD = 10;

    if (health.outstandingAmount > AMOUNT_THRESHOLD || health.outstandingOrders > ORDER_THRESHOLD) {
      if (OPS_ALERT_EMAIL) {
        await sendEmail({
          to: OPS_ALERT_EMAIL,
          subject: `⚠️ Escrow Alert: ${health.outstandingOrders} pending orders (${(health.outstandingAmount / 100).toLocaleString()} ${health.currency})`,
          html: `
            <h2>Escrow Balance Alert</h2>
            <p>Outstanding escrow orders: <strong>${health.outstandingOrders}</strong></p>
            <p>Total outstanding amount: <strong>${(health.outstandingAmount / 100).toLocaleString()} ${health.currency}</strong></p>
            <h3>Breakdown by status:</h3>
            <ul>
              ${Object.entries(health.statusBreakdown).map(([status, data]) =>
                `<li>${status}: ${data.count} orders, ${(data.amount / 100).toLocaleString()} ${health.currency}</li>`
              ).join("")}
            </ul>
            <p>Ensure your Paystack balance covers this amount.</p>
          `,
        });
        logger.info("Escrow alert email sent", { to: OPS_ALERT_EMAIL });
      }
    }
  },

  async updateProviderConfig(
    providerId: string,
    input: Partial<{
      enabled: boolean;
      payoutSupported: boolean;
      otpChannel: "SMS" | "EMAIL" | "SMS_EMAIL";
      protectionWindowHours: number;
      notes: string | null;
    }>,
  ) {
    const existing = await prisma.escrowProviderConfig.findUnique({ where: { id: providerId } });
    if (!existing) {
      throw new AppError("Escrow provider config not found", 404);
    }
    return prisma.escrowProviderConfig.update({
      where: { id: providerId },
      data: {
        ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
        ...(typeof input.payoutSupported === "boolean" ? { payoutSupported: input.payoutSupported } : {}),
        ...(input.otpChannel ? { otpChannel: input.otpChannel } : {}),
        ...(typeof input.protectionWindowHours === "number" ? { protectionWindowHours: input.protectionWindowHours } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
  },
};
