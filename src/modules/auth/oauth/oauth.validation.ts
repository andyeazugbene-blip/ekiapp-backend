import { AppError } from "../../../shared/errors/app-error";

export function validateProviderTokenInput(input: unknown): { idToken: string; name?: string } {
  if (!input || typeof input !== "object") throw new AppError("Invalid request body", 400);
  const { idToken, identityToken, name, fullName } = input as Record<string, unknown>;
  const token = idToken ?? identityToken;
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    throw new AppError("Provider token is required", 400);
  }
  // Apple only supplies the user's name on the client on first authorization
  // (never inside the identity token JWT) — the client forwards it once,
  // here, if it has it. `name`/`fullName` accepted for Google/Apple respectively.
  const rawName = typeof name === "string" ? name : typeof fullName === "string" ? fullName : undefined;
  return { idToken: token.trim(), name: rawName?.trim() || undefined };
}

export function validateLinkInput(input: unknown): { ticket: string; email: string; password: string } {
  if (!input || typeof input !== "object") throw new AppError("Invalid request body", 400);
  const { ticket, email, password } = input as Record<string, unknown>;
  if (!ticket || typeof ticket !== "string") throw new AppError("ticket is required", 400);
  if (!email || typeof email !== "string") throw new AppError("email is required", 400);
  if (!password || typeof password !== "string") throw new AppError("password is required", 400);
  return { ticket: ticket.trim(), email: email.toLowerCase().trim(), password };
}

export function validateCompleteSignupInput(input: unknown): {
  ticket: string;
  name?: string;
  email?: string;
  phone?: string;
  country?: string;
  role: "BUYER" | "VENDOR";
  referralCode?: string;
} {
  if (!input || typeof input !== "object") throw new AppError("Invalid request body", 400);
  const raw = input as Record<string, unknown>;
  if (!raw.ticket || typeof raw.ticket !== "string") throw new AppError("ticket is required", 400);

  const roleRaw = typeof raw.role === "string" ? raw.role.toUpperCase() : "";
  if (roleRaw !== "BUYER" && roleRaw !== "VENDOR") {
    throw new AppError("role must be BUYER or VENDOR", 400);
  }

  return {
    ticket: raw.ticket.trim(),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined,
    email: typeof raw.email === "string" && raw.email.trim() ? raw.email.toLowerCase().trim() : undefined,
    phone: typeof raw.phone === "string" && raw.phone.trim() ? raw.phone.trim() : undefined,
    country: typeof raw.country === "string" && raw.country.trim() ? raw.country.trim() : undefined,
    role: roleRaw,
    referralCode: typeof raw.referralCode === "string" && raw.referralCode.trim() ? raw.referralCode.trim().toUpperCase() : undefined,
  };
}
