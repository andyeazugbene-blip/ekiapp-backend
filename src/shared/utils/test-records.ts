/**
 * Handbook 2.1 L139 / 14.12 — test (QA/seed) records are excluded from
 * production metrics by default. Admin aggregate endpoints run inside a
 * request-scoped context (set from `?includeTest=true`) so deep service code
 * can ask `notTest()` without every signature growing a flag.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

interface TestRecordScope {
  includeTest: boolean;
}

const storage = new AsyncLocalStorage<TestRecordScope>();

export function parseIncludeTest(raw: unknown): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === true || value === "true" || value === "1";
}

/** Express middleware: scope the rest of the request to includeTest. */
export function testRecordScope(request: Request, _response: Response, next: NextFunction): void {
  storage.run({ includeTest: parseIncludeTest(request.query.includeTest) }, () => next());
}

export function runWithTestScope<T>(includeTest: boolean, fn: () => T): T {
  return storage.run({ includeTest }, fn);
}

export function includeTestRecords(): boolean {
  return storage.getStore()?.includeTest ?? false;
}

/** `{ isTest: false }` unless the caller asked to include test records. */
export function notTest(): { isTest?: false } {
  return includeTestRecords() ? {} : { isTest: false };
}

/** Same filter for relations: `{ order: notTestRel("order") }` style helpers. */
export function notTestOf<K extends string>(relation: K): { [P in K]?: { isTest: false } } {
  return (includeTestRecords() ? {} : { [relation]: { isTest: false } }) as { [P in K]?: { isTest: false } };
}
