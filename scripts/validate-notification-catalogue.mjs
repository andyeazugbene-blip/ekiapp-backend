#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const COLUMNS = [
  "original_id", "original_name", "source_page_or_row", "business_intent",
  "recipient_role", "trigger_event_and_state", "timing_and_source", "eligibility",
  "stop_condition", "owner", "channels", "baseline_copy", "destination_key",
  "source_status", "qa_evidence", "notes",
];
const SOURCE_STATUSES = new Set(["UNVERIFIED", "SOURCE_CONFIRMED", "MAPPED", "BLOCKED"]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      if (cell.length) throw new Error(`Unexpected quote at character ${i + 1}`);
      quoted = true;
    } else if (char === ",") {
      row.push(cell); cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value.trim())) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

export function validateCatalogue(text, { expectedCount = 210 } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("CSV is empty; include the exact template header");
  if (rows[0].length !== COLUMNS.length || rows[0].some((value, index) => value !== COLUMNS[index])) {
    throw new Error("Header does not match the reconciliation template exactly");
  }
  const ids = new Set();
  for (const [index, values] of rows.slice(1).entries()) {
    const line = index + 2;
    if (values.length !== COLUMNS.length) throw new Error(`Line ${line} has ${values.length} columns; expected ${COLUMNS.length}`);
    const item = Object.fromEntries(COLUMNS.map((column, columnIndex) => [column, values[columnIndex].trim()]));
    for (const field of ["original_id", "original_name", "source_page_or_row", "source_status"]) {
      if (!item[field]) throw new Error(`Line ${line} requires ${field}`);
    }
    if (ids.has(item.original_id)) throw new Error(`Line ${line} duplicates original_id ${item.original_id}`);
    ids.add(item.original_id);
    if (!SOURCE_STATUSES.has(item.source_status)) throw new Error(`Line ${line} has unsupported source_status ${item.source_status}`);
  }
  if (rows.length - 1 !== expectedCount) {
    throw new Error(`Expected ${expectedCount} source records; found ${rows.length - 1}`);
  }
  return { count: rows.length - 1, columns: COLUMNS.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const templateOnly = args.includes("--template");
    const inputPath = args.find((argument) => !argument.startsWith("-"));
    if (!inputPath) throw new Error("Usage: node scripts/validate-notification-catalogue.mjs <catalogue.csv> [--template]");
    const text = await readFile(inputPath, "utf8");
    const result = validateCatalogue(text, { expectedCount: templateOnly ? 0 : 210 });
    console.log(templateOnly
      ? `Valid empty reconciliation template: ${result.columns} columns`
      : `Valid source-backed catalogue: ${result.count} records, ${result.columns} columns`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
