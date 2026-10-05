import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decide } = require("../../scripts/vercel-migrate.js") as { decide: (env: Record<string, string | undefined>) => { migrate: boolean; reason: string } };

describe("vercel-migrate deployment decision", () => {
  it("production deployment migrates", () => {
    expect(decide({ VERCEL_ENV: "production" }).migrate).toBe(true);
    expect(decide({ VERCEL_ENV: " Production " }).migrate).toBe(true);
  });

  it("preview NEVER migrates (even with a production-looking DATABASE_URL)", () => {
    expect(decide({ VERCEL_ENV: "preview", DATABASE_URL: "postgres://prod" }).migrate).toBe(false);
  });

  it("development, unset and unknown values never migrate (fail safe)", () => {
    for (const v of ["development", "", undefined, "staging", "prod", "true"]) {
      expect(decide({ VERCEL_ENV: v }).migrate).toBe(false);
    }
  });

  it("FORCE_MIGRATE=1 is an explicit opt-in only", () => {
    expect(decide({ VERCEL_ENV: "preview", FORCE_MIGRATE: "1" }).migrate).toBe(true);
    expect(decide({ VERCEL_ENV: "preview", FORCE_MIGRATE: "true" }).migrate).toBe(false);
    expect(decide({ VERCEL_ENV: "preview", FORCE_MIGRATE: "0" }).migrate).toBe(false);
  });

  it("running the script for a preview build exits 0 without invoking prisma", () => {
    const out = execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/vercel-migrate.js")], {
      env: { ...process.env, VERCEL_ENV: "preview", FORCE_MIGRATE: "" },
      encoding: "utf8",
    });
    expect(out).toContain("SKIP prisma migrate deploy");
  });

  it("package.json routes vercel-build through the guard (no bare migrate deploy)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as { scripts: Record<string, string> };
    expect(pkg.scripts["vercel-build"]).toContain("scripts/vercel-migrate.js");
    expect(pkg.scripts["vercel-build"]).not.toMatch(/prisma migrate deploy/);
  });
});
