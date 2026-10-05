import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCTION_ORIGINS, parseOriginList, resolveCorsOrigins } from "../config/cors";

describe("resolveCorsOrigins", () => {
  it("uses the canonical CORS_ORIGINS", () => {
    const r = resolveCorsOrigins({ CORS_ORIGINS: "https://a.example.com, https://b.example.com/" }, true);
    expect(r.origins).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(r.source).toBe("CORS_ORIGINS");
  });

  it("accepts the legacy singular CORS_ORIGIN (what production was configured with)", () => {
    const r = resolveCorsOrigins({ CORS_ORIGIN: "https://admin.example.com" }, true);
    expect(r.origins).toEqual(["https://admin.example.com"]);
    expect(r.source).toBe("CORS_ORIGIN");
  });

  it("CORS_ORIGINS wins when both are set", () => {
    const r = resolveCorsOrigins({ CORS_ORIGINS: "https://new.example.com", CORS_ORIGIN: "https://old.example.com" }, true);
    expect(r.origins).toEqual(["https://new.example.com"]);
  });

  it("production with nothing configured uses the built-in allow-list, never 'allow all'", () => {
    const r = resolveCorsOrigins({}, true);
    expect(r.origins).toEqual(DEFAULT_PRODUCTION_ORIGINS);
    expect(r.origins).not.toBe(true);
  });

  it("an empty value (as in .env.example) counts as not configured", () => {
    expect(resolveCorsOrigins({ CORS_ORIGINS: "  ", CORS_ORIGIN: "" }, true).source).toBe("default");
  });

  it("wildcard can never widen production access", () => {
    const r = resolveCorsOrigins({ CORS_ORIGINS: "*" }, true);
    expect(r.origins).toEqual(DEFAULT_PRODUCTION_ORIGINS);
    expect(r.rejected).toEqual(["*"]);
  });

  it("drops invalid entries but keeps valid ones", () => {
    const r = resolveCorsOrigins({ CORS_ORIGINS: "https://ok.example.com,*,http://insecure.example.com,https://x.com/path,javascript:alert(1)" }, true);
    expect(r.origins).toEqual(["https://ok.example.com"]);
    expect(r.rejected.length).toBe(4);
  });

  it("production rejects http and localhost origins", () => {
    const { valid } = parseOriginList("http://localhost:3000,https://localhost:3000,https://127.0.0.1", true);
    expect(valid).toEqual([]);
  });

  it("non-production may use http/localhost and defaults to open when unset", () => {
    expect(parseOriginList("http://localhost:3100", false).valid).toEqual(["http://localhost:3100"]);
    expect(resolveCorsOrigins({}, false).origins).toBe(true);
  });

  it("non-production with only invalid values stays open but reports them", () => {
    const r = resolveCorsOrigins({ CORS_ORIGINS: "*" }, false);
    expect(r.rejected).toEqual(["*"]);
  });

  it("lower-cases and de-duplicates", () => {
    expect(parseOriginList("https://A.example.com,https://a.example.com", true).valid).toEqual(["https://a.example.com"]);
  });
});
