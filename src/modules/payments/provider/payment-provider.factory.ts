import { stripeProvider } from "./stripe-provider";
import { paystackProvider } from "./paystack-provider";
import type { PaymentProvider } from "./payment-provider.interface";

const PAYSTACK_COUNTRIES = new Set(["nigeria", "ng", "ghana", "gh"]);

export const paymentProviderFactory = {
  /** Same country → rail mapping already used by paystackService.initializeEscrowCheckout and the ADR (docs/decisions/0001). */
  forVendorCountry(country: string | null | undefined): PaymentProvider {
    if (country && PAYSTACK_COUNTRIES.has(country.toLowerCase())) return paystackProvider;
    return stripeProvider;
  },

  byName(name: "stripe" | "paystack"): PaymentProvider {
    return name === "paystack" ? paystackProvider : stripeProvider;
  },
};
