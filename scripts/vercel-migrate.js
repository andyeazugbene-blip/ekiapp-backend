#!/usr/bin/env node
/**
 * Vercel build step: apply Prisma migrations ONLY for real production deployments.
 *
 * Why: Preview and Production share the same DATABASE_URL in this project, so a
 * normal branch preview build running `prisma migrate deploy` would mutate the
 * PRODUCTION schema before the change was ever reviewed or merged.
 *
 * Rules:
 *  - VERCEL_ENV=production  -> run `prisma migrate deploy` (forward-only, never reset).
 *  - VERCEL_ENV=preview     -> skip, loudly. Previews never touch the schema.
 *  - VERCEL_ENV=development / unset (local `vercel build`) -> skip.
 *  - FORCE_MIGRATE=1 overrides the skip (explicit, for a dedicated staging project
 *    that has its OWN database). Never set it on a project sharing the prod DB.
 */
const { spawnSync } = require("node:child_process");

const env = (process.env.VERCEL_ENV || "").toLowerCase();
const force = process.env.FORCE_MIGRATE === "1";

if (env !== "production" && !force) {
  console.log(
    `[vercel-migrate] VERCEL_ENV="${env || "unset"}": skipping prisma migrate deploy ` +
      "(only production deployments may change the database schema).",
  );
  process.exit(0);
}

console.log(`[vercel-migrate] VERCEL_ENV="${env || "unset"}"${force ? " (FORCE_MIGRATE=1)" : ""}: running prisma migrate deploy`);
const res = spawnSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(res.status ?? 1);
