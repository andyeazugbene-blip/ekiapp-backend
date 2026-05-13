// Pure pricing helpers. No DB, no env, no I/O — safe to unit-test.
//
// All amounts are integer cents. Fees and totals must remain integers
// at every step to avoid floating-point drift in financial math.

/**
 * Platform fee in cents, derived from a subtotal in cents and a basis-points
 * rate. 1 basis point = 0.01%, so `feeBps = 1000` ⇒ 10%. The result is rounded
 * to the nearest integer cent.
 */
export function calculatePlatformFee(subtotalAmount: number, feeBps: number): number {
  if (!Number.isFinite(subtotalAmount) || subtotalAmount < 0) {
    throw new Error("subtotalAmount must be a non-negative finite number");
  }
  if (!Number.isFinite(feeBps) || feeBps < 0) {
    throw new Error("feeBps must be a non-negative finite number");
  }
  return Math.round((subtotalAmount * feeBps) / 10000);
}

/**
 * Delivery fee in cents from a flat base fee plus a per-kg surcharge.
 * Weight is rounded UP to the nearest whole kilogram before multiplying.
 */
export function calculateDeliveryFee(input: {
  baseFeeAmount: number;
  feePerKgAmount: number;
  totalWeightGrams: number;
}): number {
  const { baseFeeAmount, feePerKgAmount, totalWeightGrams } = input;
  if (baseFeeAmount < 0 || feePerKgAmount < 0 || totalWeightGrams < 0) {
    throw new Error("delivery fee inputs must be non-negative");
  }
  const weightKgCeil = Math.ceil(totalWeightGrams / 1000);
  return baseFeeAmount + weightKgCeil * feePerKgAmount;
}

/**
 * Vendor earnings = subtotal − platform fee. Delivery fee is excluded
 * from vendor earnings by design.
 */
export function calculateVendorEarnings(subtotalAmount: number, platformFeeAmount: number): number {
  return subtotalAmount - platformFeeAmount;
}
