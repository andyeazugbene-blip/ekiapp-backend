import { prisma } from "../../lib/prisma";
import { resolveMarketCode } from "../../shared/currency";
import { AppError } from "../../shared/errors/app-error";

/**
 * Client decision (2026-09-22, "VERIFY BUYER COUNTRY IMPLEMENTATION" audit +
 * follow-up fix): Community Buy discovery/access must be scoped to the
 * authenticated buyer's own registered country — never to a client-supplied
 * value (query string, request body, etc). This is the single place that
 * resolves "which market does this buyer belong to," so every call site
 * (discovery, direct campaign access, join, pledge) uses the identical rule
 * instead of five slightly-different re-implementations.
 *
 * Both "no country set" and "country doesn't resolve to any known market"
 * are treated as the same outcome on purpose: from Community Buy's
 * perspective they mean the same thing (no eligible market can be
 * determined for this buyer), and inventing a second, silently-different
 * behavior for one vs the other would be exactly the kind of extra rule the
 * acceptance workflow didn't ask for.
 */
export const buyerCountryService = {
  /** Resolves the AUTHENTICATED buyer's own country (User.country, a real DB read) to a canonical market code, or null if unset/unresolvable. */
  async resolveMarketCode(userId: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
    return user?.country ? resolveMarketCode(user.country) : null;
  },

  /** Same as resolveMarketCode(), but throws a clear 403 instead of returning null — for endpoints that cannot proceed at all without a known buyer market. */
  async requireMarketCode(userId: string): Promise<string> {
    const marketCode = await this.resolveMarketCode(userId);
    if (!marketCode) {
      throw new AppError(
        "Add your country to your profile to see Community Buy campaigns in your market.",
        403,
        undefined,
        "COUNTRY_REQUIRED",
      );
    }
    return marketCode;
  },

  /** Normalizes a CommunityCampaign.country value the same way — falls back to a literal uppercase match (never a guess) for a value that doesn't resolve, matching marketConfigurationService.get()'s existing fallback so both sides of any comparison use one consistent rule. */
  resolveCampaignMarketCode(campaignCountry: string): string {
    return resolveMarketCode(campaignCountry) ?? campaignCountry.trim().toUpperCase();
  },

  /** True only when the buyer's own resolved market matches the campaign's resolved market — never true for a missing/unresolvable buyer country. */
  isEligible(buyerMarketCode: string | null, campaignCountry: string | null | undefined): boolean {
    if (!buyerMarketCode || !campaignCountry) return false;
    return buyerMarketCode === this.resolveCampaignMarketCode(campaignCountry);
  },
};
