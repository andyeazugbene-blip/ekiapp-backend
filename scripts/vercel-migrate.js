#!/usr/bin/env node
/**
 * Vercel build step: apply Prisma migrations ONLY for real production deployments.
 *
 * Why: Preview and Production may share the same DATABASE_URL, so a normal branch
 * preview build running `prisma migrate deploy` would mutate the PRODUCTION schema
 * before the change was reviewed or merged.
 *
 * Decision table (pure function `decide`, unit-tested):
 *   VERCEL_ENV=production                      -> migrate
 *   VERCEL_ENV=preview | development | unset   -> skip
 *   anything unrecognised                      -> skip (fail safe)
 *   FORCE_MIGRATE=1 AND VERCEL_ENV!=production -> migrate (explicit opt-in, for a
 *     dedicated staging project with its OWN database; never set it on a project
 *     that shares the production DATABASE_URL)
 *
 * This script is a guardrail, not isolation: the Preview environment must ALSO get
 * its own DATABASE_URL in the Vercel dashboard (see docs/PRODUCTION_ENVIRONMENT_CHECKLIST.md).
 */
const { spawnSync } = require("node:child_process");

function decide(env) {
  const vercelEnv = String(env.VERCEL_ENV || "").trim().toLowerCase();
  const force = env.FORCE_MIGRATE === "1";
  if (vercelEnv === "production") return { migrate: true, reason: "production deployment" };
  if (force) return { migrate: true, reason: `FORCE_MIGRATE=1 (VERCEL_ENV=${vercelEnv || "unset"})` };
  return {
    migrate: false,
    reason: `VERCEL_ENV="${vercelEnv || "unset"}": only production deployments may change the database schema`,
  };
}

function main() {
  const d = decide(process.env);
  if (!d.migrate) {
    console.log(`[vercel-migrate] SKIP prisma migrate deploy - ${d.reason}`);
    return 0;
  }
  console.log(`[vercel-migrate] RUN prisma migrate deploy - ${d.reason}`);
  const res = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", shell: process.platform === "win32" });
  return res.status ?? 1;
}

module.exports = { decide };

if (require.main === module) process.exit(main());
