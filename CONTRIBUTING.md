# Contributing

## Local Setup

```bash
git clone <repo>
cd italian-market-place
npm install
cp .env.example .env  # fill in values
npx prisma generate
npx prisma migrate dev
npx prisma db seed
npm run dev
```

## Environment Variables
See `.env.example` for the full list. Minimum for local dev:
- `DATABASE_URL` (local Postgres or Neon branch)
- `JWT_SECRET` (any string)
- `STRIPE_SECRET_KEY` (test key)
- `STRIPE_WEBHOOK_SECRET` (from Stripe CLI or dashboard)

## Database Commands
```bash
npx prisma generate          # regenerate client after schema change
npx prisma migrate dev       # create + apply migration (dev)
npx prisma migrate deploy    # apply migrations (production)
npx prisma db seed           # seed demo data
npx prisma studio            # visual DB browser
```

## Test Commands
```bash
npx vitest run               # run all tests
npx vitest run src/tests/auth.test.ts  # run specific file
npx tsc --noEmit             # type check
npm run check:scaffolding    # check for AI placeholder phrases
npm run test:coverage-map    # module test coverage report
```

## Commit Convention
We use [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: add new feature
fix: fix a bug
docs: documentation only
refactor: code change that neither fixes nor adds
test: adding tests
chore: maintenance
```
Header max 100 characters. Commitlint enforces this via husky pre-commit hook.

## PR Checklist
- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes
- [ ] `npm run check:scaffolding` passes
- [ ] No secrets in code or commit messages
- [ ] Migration is idempotent (uses IF NOT EXISTS / DO $$ BEGIN...EXCEPTION)
- [ ] Money-adjacent changes have tests
- [ ] README updated if behavior changes

## Adding Migrations
```bash
# 1. Edit prisma/schema.prisma
# 2. Create migration file:
mkdir prisma/migrations/YYYYMMDD_description
# 3. Write SQL in migration.sql (use IF NOT EXISTS for safety)
# 4. Apply:
npx prisma migrate dev
# 5. Verify:
npx prisma generate
npx tsc --noEmit
```

## Production Smoke Tests
```bash
npm run launch:health         # verify all services
npm run reconcile:wallets     # wallet ledger check
npm run reconcile:stripe      # Stripe payment check
npm run launch:load-smoke     # latency + error rate
```
