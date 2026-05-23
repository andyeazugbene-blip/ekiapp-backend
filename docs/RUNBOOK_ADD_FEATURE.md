# Runbook: Adding a New Feature

## Before Starting
1. Check `docs/process/NEW_MODULE_GATE.md` — does this need a new module?
2. Can an existing module handle it?
3. Is there a security/financial risk?

## Steps
1. **Schema change** (if needed): edit `prisma/schema.prisma`, create migration
2. **Service**: business logic in `src/modules/{module}/{module}.service.ts`
3. **Controller**: thin HTTP handler in `{module}.controller.ts`
4. **Validation**: input validation in `{module}.validation.ts`
5. **Routes**: wire in `{module}.routes.ts`, mount in `src/routes/index.ts`
6. **Tests**: add to `src/tests/`
7. **Verify**: `npx tsc --noEmit && npx vitest run && npm run check:scaffolding`

## Money-Adjacent Features (Extra Steps)
- Add DB CHECK constraint if new monetary field
- Add reconciliation check if new ledger
- Add idempotency guard if new webhook/payment path
- Add to `npm run reconcile:wallets` if wallet-affecting
- Get code review from money-domain owner
