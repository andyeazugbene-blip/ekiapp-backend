import type { PayoutRequestStatus } from "@prisma/client";

export interface CreatePayoutRequestInput {
  payoutMethodId: string;
  amount: number;
  notes?: string;
}

export interface RejectPayoutRequestInput {
  reason?: string;
}

export interface ListPayoutRequestsQuery {
  status?: PayoutRequestStatus;
}
