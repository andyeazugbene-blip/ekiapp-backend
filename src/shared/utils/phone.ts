import { AppError } from "../errors/app-error";

const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;

export function normalizePhoneNumber(value: string, field = "phone"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AppError(`Invalid ${field}`, 400);
  }

  let normalized = trimmed.replace(/[\s().-]/g, "");
  normalized = normalized.replace(/(?!^)\+/g, "");

  if (normalized.startsWith("00")) {
    normalized = `+${normalized.slice(2)}`;
  }

  if (!PHONE_REGEX.test(normalized)) {
    throw new AppError(`Invalid ${field}`, 400);
  }

  return normalized;
}
