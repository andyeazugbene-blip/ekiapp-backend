import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COLUMNS, validateCatalogue } from "./validate-notification-catalogue.mjs";

const header = COLUMNS.join(",");
const record = (id) => [id, `Legacy event ${id}`, "handbook p. 1", "", "", "", "", "", "", "", "", "", "", "UNVERIFIED", "", ""].join(",");

test("the provided empty template has the exact reconciliation header and does not invent records", async () => {
  const template = await readFile(new URL("../docs/notification-orchestration/210-event-reconciliation-template.csv", import.meta.url), "utf8");
  assert.equal(template.trim(), header);
  assert.deepEqual(validateCatalogue(template, { expectedCount: 0 }), { count: 0, columns: COLUMNS.length });
});

test("validates exactly 210 unique source-backed IDs while allowing unknown mappings to remain blank", () => {
  const csv = `${header}\n${Array.from({ length: 210 }, (_, index) => record(`legacy-${index + 1}`)).join("\n")}\n`;
  assert.deepEqual(validateCatalogue(csv), { count: 210, columns: COLUMNS.length });
});

test("rejects duplicate IDs, missing source locations, unsupported status and wrong record counts", () => {
  assert.throws(() => validateCatalogue(`${header}\n${record("same")}\n${record("same")}`, { expectedCount: 2 }), /duplicates original_id/);
  assert.throws(() => validateCatalogue(`${header}\n${record("x").replace("handbook p. 1", "")}`, { expectedCount: 1 }), /requires source_page_or_row/);
  assert.throws(() => validateCatalogue(`${header}\n${record("x").replace("UNVERIFIED", "APPROVED")}`, { expectedCount: 1 }), /unsupported source_status/);
  assert.throws(() => validateCatalogue(`${header}\n${record("x")}`), /Expected 210 source records; found 1/);
});

test("rejects malformed CSV rows and header drift", () => {
  assert.throws(() => validateCatalogue(`${header}\n${record("x")},extra`, { expectedCount: 1 }), /has 17 columns/);
  assert.throws(() => validateCatalogue(`${header.replace("original_id", "id")}`), /Header does not match/);
  assert.throws(() => validateCatalogue(`${header}\n${record("x").replace("Legacy event x", '"unterminated')}`, { expectedCount: 1 }), /ends inside a quoted field/);
});
