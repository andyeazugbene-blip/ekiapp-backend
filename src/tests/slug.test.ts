import { describe, it, expect } from "vitest";

import { resolveUniqueSlug, slugify } from "../shared/utils/slug";

describe("slugify", () => {
  it("lowercases and hyphenates words", () => {
    expect(slugify("Mama Chi Foodstuff")).toBe("mama-chi-foodstuff");
  });

  it("strips diacritics", () => {
    expect(slugify("Caffè Italiano")).toBe("caffe-italiano");
  });

  it("collapses multiple separators", () => {
    expect(slugify("  Hello   World!! ")).toBe("hello-world");
  });

  it("removes non-ASCII characters entirely", () => {
    expect(slugify("Pâtisserie Élysée 2024")).toBe("patisserie-elysee-2024");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("---store---")).toBe("store");
  });

  it("returns empty string for input with no usable characters", () => {
    expect(slugify("!!!")).toBe("");
  });

  it("handles single-word names", () => {
    expect(slugify("Pizzeria")).toBe("pizzeria");
  });

  it("handles numbers", () => {
    expect(slugify("Store 123")).toBe("store-123");
  });
});

describe("resolveUniqueSlug", () => {
  it("returns the base slug when no collision", async () => {
    const result = await resolveUniqueSlug("Mama Chi Foodstuff", async () => false);
    expect(result).toBe("mama-chi-foodstuff");
  });

  it("appends -2 on first collision", async () => {
    const taken = new Set(["mama-chi-foodstuff"]);
    const result = await resolveUniqueSlug(
      "Mama Chi Foodstuff",
      async (s) => taken.has(s),
    );
    expect(result).toBe("mama-chi-foodstuff-2");
  });

  it("keeps incrementing until a free slug is found", async () => {
    const taken = new Set([
      "mama-chi-foodstuff",
      "mama-chi-foodstuff-2",
      "mama-chi-foodstuff-3",
    ]);
    const result = await resolveUniqueSlug(
      "Mama Chi Foodstuff",
      async (s) => taken.has(s),
    );
    expect(result).toBe("mama-chi-foodstuff-4");
  });

  it("falls back to 'store' when input slugifies to empty", async () => {
    const result = await resolveUniqueSlug("!!!", async () => false);
    expect(result).toBe("store");
  });

  it("falls back to a timestamped slug after maxAttempts", async () => {
    const result = await resolveUniqueSlug(
      "Pizza",
      async () => true, // every candidate is taken
      { maxAttempts: 3 },
    );
    // Either pattern: pizza-<base36-timestamp>
    expect(result).toMatch(/^pizza-[0-9a-z]+$/);
    expect(result).not.toBe("pizza");
    expect(result).not.toBe("pizza-2");
  });
});
