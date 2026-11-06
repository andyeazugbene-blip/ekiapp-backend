import { describe, expect, it } from "vitest";

import { decodeRankCursor, encodeRankCursor, productScore } from "../modules/products/product-ranking";

const product = (over = {}) => ({ title: "Long grain rice", category: "Grains", description: "Sold in 5kg bags", stock: 10, ...over });
const signals = (over = {}) => ({ unitsSold: 0, vendorRating: null, deliversToViewer: false, newVendor: false, ...over });

describe("productScore", () => {
  it("ranks a title match above a description match", () => {
    const inTitle = productScore(product(), signals({ search: "rice" }));
    const inDescription = productScore(product({ title: "Beans", description: "Goes well with rice" }), signals({ search: "rice" }));
    expect(inTitle).toBeGreaterThan(inDescription);
  });

  it("ignores letter case in a search", () => {
    expect(productScore(product(), signals({ search: "RICE" }))).toBe(productScore(product(), signals({ search: "rice" })));
  });

  it("a better vendor rating ranks higher", () => {
    expect(productScore(product(), signals({ vendorRating: 5 }))).toBeGreaterThan(productScore(product(), signals({ vendorRating: 2 })));
  });

  it("delivering to the buyer's country ranks higher", () => {
    expect(productScore(product(), signals({ deliversToViewer: true }))).toBeGreaterThan(productScore(product(), signals()));
  });

  it("a new vendor can reach a buyer ahead of a modest seller", () => {
    expect(productScore(product(), signals({ newVendor: true }))).toBeGreaterThan(productScore(product(), signals({ unitsSold: 3 })));
  });

  it("sales help, with diminishing effect", () => {
    const at = (unitsSold: number) => productScore(product(), signals({ unitsSold }));
    expect(at(10)).toBeGreaterThan(at(0));
    expect(at(1000) - at(100)).toBeLessThan(at(100) - at(10) + 1);
    expect(at(10000)).toBeLessThan(200);
  });

  it("a sold-out product drops, but keeps a score", () => {
    expect(productScore(product({ stock: 0 }), signals())).toBeLessThan(productScore(product(), signals()));
  });

  it("copes with a product that has no category or description", () => {
    expect(() => productScore(product({ category: null, description: null }), signals({ search: "rice" }))).not.toThrow();
  });
});

describe("rank cursor", () => {
  it("round-trips", () => {
    expect(decodeRankCursor(encodeRankCursor(100))).toBe(100);
  });

  it("starts from the top for an old-style or bad cursor", () => {
    expect(decodeRankCursor("cmabc123")).toBe(0);
    expect(decodeRankCursor("rank:-5")).toBe(0);
    expect(decodeRankCursor("rank:abc")).toBe(0);
    expect(decodeRankCursor(undefined)).toBe(0);
  });
});
