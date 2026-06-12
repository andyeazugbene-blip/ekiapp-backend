import type { RewardType } from "@prisma/client";

export interface CreateRewardInput {
  name: string;
  description?: string;
  type: RewardType;
  value: number;
  currency?: string;
  minOrderAmount?: number;
  isActive?: boolean;
  maxClaims?: number;
  expiresAt?: string;
}

export interface UpdateRewardInput {
  name?: string;
  description?: string | null;
  type?: RewardType;
  value?: number;
  currency?: string;
  minOrderAmount?: number;
  isActive?: boolean;
  maxClaims?: number;
  expiresAt?: string | null;
}

export interface ClaimRewardInput {
  referralCode: string;
}

export interface RewardView {
  id: string;
  name: string;
  description: string | null;
  type: RewardType;
  value: number;
  currency: string;
  minOrderAmount: number | null;
  isActive: boolean;
  maxClaims: number | null;
  claimedCount: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface UserRewardView {
  id: string;
  rewardId: string;
  rewardName: string;
  rewardType: RewardType;
  rewardValue: number;
  rewardCurrency: string;
  claimedAt: string;
  usedAt: string | null;
  expiresAt: string | null;
  description: string | null;
}
