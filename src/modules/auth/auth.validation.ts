import { AppError } from "../../shared/errors/app-error";
import { normalizePhoneNumber } from "../../shared/utils/phone";
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from "./auth.types";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_UPPER = /[A-Z]/;
const PASSWORD_LOWER = /[a-z]/;
const PASSWORD_DIGIT = /\d/;

function assertPasswordStrength(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`, 400);
  }
  if (!PASSWORD_UPPER.test(password)) {
    throw new AppError("Password must contain at least one uppercase letter", 400);
  }
  if (!PASSWORD_LOWER.test(password)) {
    throw new AppError("Password must contain at least one lowercase letter", 400);
  }
  if (!PASSWORD_DIGIT.test(password)) {
    throw new AppError("Password must contain at least one digit", 400);
  }
}

export function validateRegisterInput(input: unknown): RegisterInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }

  const { email, password, name, phone, country } = input as Record<string, unknown>;

  if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    throw new AppError("Invalid email", 400);
  }

  if (!password || typeof password !== "string") {
    throw new AppError("Password is required", 400);
  }
  assertPasswordStrength(password as string);

  if (!name || typeof name !== "string" || (name as string).trim().length === 0) {
    throw new AppError("Invalid name", 400);
  }

  return {
    email: (email as string).toLowerCase().trim(),
    password: password as string,
    name: (name as string).trim(),
    phone: typeof phone === "string" && phone.trim().length > 0 ? normalizePhoneNumber(phone, "phone") : undefined,
    country: typeof country === "string" && country.trim().length > 0 ? country.trim() : undefined,
  };
}

export function validateLoginInput(input: unknown): LoginInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }

  const { email, password } = input as Partial<LoginInput>;

  if (!email || typeof email !== "string") {
    throw new AppError("Invalid email", 400);
  }

  if (!password || typeof password !== "string") {
    throw new AppError("Invalid password", 400);
  }

  return {
    email: email.toLowerCase().trim(),
    password,
  };
}

export function validateUpdateProfileInput(input: unknown): UpdateProfileInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const raw = input as Record<string, unknown>;
  const update: UpdateProfileInput = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
      throw new AppError("Invalid name", 400);
    }
    update.name = raw.name.trim();
  }

  if (raw.phone !== undefined) {
    update.phone =
      raw.phone === null
        ? null
        : typeof raw.phone === "string"
          ? raw.phone.trim().length > 0
            ? normalizePhoneNumber(raw.phone, "phone")
            : null
          : null;
  }

  if (raw.avatar !== undefined) {
    update.avatar = raw.avatar === null ? null : typeof raw.avatar === "string" ? raw.avatar.trim() || null : null;
  }

  if (raw.country !== undefined) {
    update.country = raw.country === null ? null : typeof raw.country === "string" ? raw.country.trim() || null : null;
  }

  if (Object.keys(update).length === 0) {
    throw new AppError("No fields to update", 400);
  }

  return update;
}

export function validateForgotPasswordInput(input: unknown): ForgotPasswordInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const { email } = input as Record<string, unknown>;

  if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    throw new AppError("Invalid email", 400);
  }

  return { email: email.toLowerCase().trim() };
}

export function validateResetPasswordInput(input: unknown): ResetPasswordInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }
  const { token, password } = input as Record<string, unknown>;

  if (!token || typeof token !== "string" || token.trim().length === 0) {
    throw new AppError("Invalid token", 400);
  }

  if (!password || typeof password !== "string") {
    throw new AppError("Password is required", 400);
  }
  assertPasswordStrength(password as string);

  return { token: token.trim(), password: password as string };
}
