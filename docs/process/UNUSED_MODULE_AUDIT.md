# Unused Module Audit

## Schedule
- **60 days after soft launch:** first audit
- **Every quarter thereafter**

## Process
1. For each module in `src/modules/`, count API calls in the last 30 days
2. If a module has <10 API calls in 30 days, flag it
3. Review with product owner: is this expected? (seasonal, not yet launched, etc.)
4. If genuinely unused:
   - Feature-flag the routes (return 410 Gone)
   - Wait 14 days for complaints
   - If no complaints: remove the module in a cleanup PR
5. Document removal in ADR

## Do Not Remove Without Review
- Money-adjacent modules (even if low traffic — they may be critical for edge cases)
- Webhook handlers (they receive traffic from providers, not users)
- Background workers (they run on schedule, not on user request)

## Metrics to Track
- Requests per module per week
- Error rate per module
- Last successful request timestamp
