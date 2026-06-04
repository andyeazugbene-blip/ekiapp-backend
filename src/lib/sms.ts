import { logger } from "./logger";
import { prisma } from "./prisma";

/**
 * SMS provider using Africa's Talking official SDK.
 * Falls back to logging in dev if SMS_API_KEY is not configured.
 *
 * Delivery OTP can be sent to buyers via SMS for escrow confirmation.
 * Failures must never block the order workflow; we log and keep the
 * manual fallback available where needed.
 */

const SMS_API_KEY = process.env.SMS_API_KEY ?? "";
const AT_USERNAME = process.env.AT_USERNAME ?? "sandbox";

let smsClient: { send: (opts: { to: string[]; message: string; enqueue?: boolean }) => Promise<unknown> } | null = null;

if (SMS_API_KEY) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AfricasTalking = require("africastalking");
    const at = AfricasTalking({ apiKey: SMS_API_KEY, username: AT_USERNAME });
    smsClient = at.SMS;
    logger.info("Africa's Talking SMS client initialized", { username: AT_USERNAME });
  } catch (error) {
    logger.error("Failed to initialize Africa's Talking SMS", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface SendSmsInput {
  to: string; // Phone number in international format (e.g. +234...)
  message: string;
  purpose?: string;
}

async function recordSms(input: SendSmsInput, status: string, providerResponse?: unknown, errorMessage?: string): Promise<void> {
  try {
    await prisma.smsDelivery.create({
      data: {
        to: input.to,
        purpose: input.purpose ?? "transactional",
        status,
        providerResponse: providerResponse as object | undefined,
        errorMessage,
      },
    });
  } catch (error) {
    logger.warn("Failed to record SMS delivery", { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Send an SMS via Africa's Talking. Falls back to logging if not configured.
 * Never throws — SMS failures must not break business operations.
 */
export async function sendSms(input: SendSmsInput): Promise<boolean> {
  if (!smsClient) {
    logger.info("SMS (dev mode, not sent)", { to: input.to, message: input.message.slice(0, 50) });
    await recordSms(input, process.env.NODE_ENV === "production" ? "NOT_CONFIGURED" : "DEV_LOGGED");
    return process.env.NODE_ENV !== "production";
  }

  try {
    const result = await smsClient.send({
      to: [input.to],
      message: input.message,
      enqueue: true,
    }) as { SMSMessageData?: { Recipients?: Array<{ status: string; statusCode: number }> } };

    const recipient = result?.SMSMessageData?.Recipients?.[0];
    if (recipient && (recipient.statusCode === 100 || recipient.statusCode === 101 || recipient.status === "Success")) {
      logger.info("SMS sent", { to: input.to });
      await recordSms(input, "SENT", result);
      return true;
    }

    logger.error("SMS delivery failed", { to: input.to, result: JSON.stringify(result).slice(0, 200) });
    await recordSms(input, "FAILED", result);
    return false;
  } catch (error) {
    logger.error("SMS send exception", {
      to: input.to,
      error: error instanceof Error ? error.message : String(error),
    });
    await recordSms(input, "ERROR", undefined, error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function isSmsConfigured(): boolean {
  return smsClient !== null;
}
