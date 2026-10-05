import { logger } from "../../lib/logger";
import { sendEmail } from "../../lib/email";
import { formatAmountDisplay } from "../../lib/email-templates";
import { notificationsService } from "../notifications/notifications.service";
import { formatGiftCardCode } from "./gift-card-code";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(content: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; padding: 40px 20px;">
<div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 32px;">
${content}
<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
<p style="font-size: 12px; color: #9ca3af; text-align: center;">Eki Marketplace</p>
</div></body></html>`;
}

export interface PaidGiftCardInfo {
  id: string;
  buyerId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  recipientEmail: string | null;
  recipientName: string | null;
  message: string | null;
  amount: number;
  currency: string;
  code: string;
  expiresAt: Date;
  title: string;
}

/**
 * Best-effort delivery after the paid-marking transaction has COMMITTED.
 * Never throws: the card is already ACTIVE and visible in the buyer's app, so
 * a mail/push failure must not roll back or fail the Stripe webhook.
 */
export async function deliverPaidGiftCard(info: PaidGiftCardInfo): Promise<void> {
  const value = formatAmountDisplay(info.amount, info.currency);
  const code = formatGiftCardCode(info.code);
  const expiry = info.expiresAt.toISOString().slice(0, 10);

  try {
    if (info.recipientEmail) {
      const from = info.buyerName ? esc(info.buyerName) : "Someone";
      await sendEmail({
        to: info.recipientEmail,
        subject: `${info.buyerName ?? "Someone"} sent you an Eki gift card`,
        html: layout(`
<h2 style="color:#111827;margin:0 0 16px;">You received a gift card</h2>
<p style="color:#374151;">${info.recipientName ? `Hi ${esc(info.recipientName)},` : "Hi,"}</p>
<p style="color:#374151;">${from} sent you an Eki gift card worth <strong>${esc(value)}</strong>.</p>
${info.message ? `<blockquote style="border-left:3px solid #096B4A;margin:16px 0;padding:4px 12px;color:#374151;white-space:pre-wrap;">${esc(info.message)}</blockquote>` : ""}
<div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0;text-align:center;">
<p style="margin:0;color:#6b7280;font-size:13px;">Your gift card code</p>
<p style="margin:8px 0 0;font-size:22px;letter-spacing:2px;font-weight:700;color:#111827;font-family:monospace;">${esc(code)}</p>
</div>
<p style="color:#6b7280;font-size:14px;">Redeem it in the Eki app under Wallet &rarr; Redeem gift card. Valid until ${esc(expiry)}.</p>`),
        text: `${info.buyerName ?? "Someone"} sent you an Eki gift card worth ${value}. Code: ${code}. Redeem it in the Eki app (Wallet > Redeem gift card). Valid until ${expiry}.`,
      });
    }

    if (info.buyerEmail) {
      await sendEmail({
        to: info.buyerEmail,
        subject: "Your Eki gift card purchase is confirmed",
        html: layout(`
<h2 style="color:#111827;margin:0 0 16px;">Gift card purchase confirmed</h2>
<p style="color:#374151;">Hi ${esc(info.buyerName ?? "there")},</p>
<p style="color:#374151;">We received your payment for a <strong>${esc(value)}</strong> gift card (${esc(info.title)}).</p>
${
  info.recipientEmail
    ? `<p style="color:#374151;">We emailed the code to <strong>${esc(info.recipientEmail)}</strong>.</p>`
    : `<p style="color:#374151;">Your gift card code is below. Share it with the person you are gifting it to.</p>
<div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0;text-align:center;"><p style="margin:0;font-size:22px;letter-spacing:2px;font-weight:700;color:#111827;font-family:monospace;">${esc(code)}</p></div>`
}
<p style="color:#6b7280;font-size:14px;">Valid until ${esc(expiry)}. You can see this card any time in the Eki app.</p>`),
      });
    }
  } catch (error) {
    logger.error("Gift card delivery email failed", {
      purchasedGiftCardId: info.id,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await notificationsService.enqueue({
      userId: info.buyerId,
      type: "ADMIN_BROADCAST",
      title: "Gift card purchase confirmed",
      body: `Your ${value} gift card is ready${info.recipientEmail ? ` and was emailed to ${info.recipientEmail}` : ""}.`,
      data: { event: "gift_card_paid", purchasedGiftCardId: info.id },
      dedupeKey: `GIFT_CARD_PAID:${info.id}`,
    });
  } catch (error) {
    logger.warn("Gift card in-app notification failed", {
      purchasedGiftCardId: info.id,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function notifyGiftCardStatusChange(params: {
  buyerId: string;
  purchasedGiftCardId: string;
  action: "cancelled" | "paused" | "resumed";
  reason: string;
  amount: number;
  currency: string;
}): Promise<void> {
  const value = formatAmountDisplay(params.amount, params.currency);
  const title =
    params.action === "cancelled" ? "Gift card cancelled" : params.action === "paused" ? "Gift card paused" : "Gift card reactivated";
  try {
    await notificationsService.enqueue({
      userId: params.buyerId,
      type: "ADMIN_BROADCAST",
      title,
      body: `Your ${value} gift card was ${params.action} by Eki support. Reason: ${params.reason}`,
      data: { event: `gift_card_${params.action}`, purchasedGiftCardId: params.purchasedGiftCardId },
    });
  } catch (error) {
    logger.warn("Gift card status notification failed", {
      purchasedGiftCardId: params.purchasedGiftCardId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
