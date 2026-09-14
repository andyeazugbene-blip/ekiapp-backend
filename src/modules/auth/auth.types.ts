import type { UserRole } from "@prisma/client";

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  phone?: string;
  country?: string;
  referralCode?: string;
  role?: Exclude<UserRole, "ADMIN">;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface JwtPayload {
  sub: string;
  role: UserRole;
  email: string;
  tv: number; // tokenVersion — for revocation
}

// Community Buy Workstream 1 (spec §3.2) — derived, never persisted
// duplicate booleans. canSelfSupply is deliberately NOT tied to canSupply:
// self-supply is an organiser sourcing goods for their OWN campaign
// (CommunityCampaign.fulfilmentOwner = SELF requires no supplier/vendor
// relationship at all), while canSupply is the marketplace-wide ability to
// accept OTHER organisers' campaigns via an approved SupplierAccount.
export interface AuthCapabilities {
  canBuy: boolean;
  canOrganise: boolean;
  canSell: boolean;
  canSupply: boolean;
  canSelfSupply: boolean;
  canReceiveSupplierPayouts: boolean;
}

export type LastDestination = "BUY" | "SELL" | "SUPPLY";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  avatar: string | null;
  country: string | null;
  referralCode: string | null;
  role: UserRole;
  hasVendor: boolean;
  trustScore: number;
  createdAt: Date;
  capabilities: AuthCapabilities;
  // A preference, never an authority (spec §3.1) — mobile is free to
  // override this locally based on actual navigation history (e.g.
  // "COMMUNITY_BUY", which the server has no way to know).
  lastDestination: LastDestination;
  storeName?: string;
  storeSlug?: string;
  storeDescription?: string | null;
  businessType?: string | null;
  sellerRegion?: string | null;
  city?: string | null;
  coverImage?: string | null;
  currency?: string | null;
  verificationStatus?: string | null;
  shareUrl?: string | null;
}

export interface UpdateProfileInput {
  name?: string;
  phone?: string | null;
  avatar?: string | null;
  country?: string | null;
}

export interface ForgotPasswordInput {
  email: string;
  role?: string;
}

export interface ResetPasswordInput {
  token: string;
  password: string;
}
