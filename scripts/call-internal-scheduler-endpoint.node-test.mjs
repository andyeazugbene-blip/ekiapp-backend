import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { callInternalSchedulerEndpoint } from "./call-internal-scheduler-endpoint.mjs";

const base = {
  name: "automation-sweep",
  path: "/api/internal/jobs/automation-sweep",
  baseUrl: "https://backend.example",
  cronSecret: "do-not-log-this-test-secret",
};

test("does not call an endpoint when the scheduler secret is missing", async () => {
  let called = false;
  await assert.rejects(
    callInternalSchedulerEndpoint({ ...base, cronSecret: "", fetchImpl: async () => { called = true; } }),
    /CRON_SECRET is unavailable/,
  );
  assert.equal(called, false);
});

test("the workflow entry point exits unsuccessfully with a clear missing-secret error", () => {
  const scriptPath = fileURLToPath(new URL("./call-internal-scheduler-endpoint.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, base.name, base.path], {
    encoding: "utf8",
    env: { ...process.env, BASE_URL: base.baseUrl, CRON_SECRET: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::automation-sweep: CRON_SECRET is unavailable/);
  assert.doesNotMatch(result.stderr, /do-not-log-this-test-secret/);
});

test("reports transport failures without including the secret or arbitrary error detail", async () => {
  await assert.rejects(
    callInternalSchedulerEndpoint({ ...base, fetchImpl: async () => { throw new Error(base.cronSecret); } }),
    (error) => {
      assert.match(error.message, /automation-sweep: request failed before an HTTP response/);
      assert.doesNotMatch(error.message, new RegExp(base.cronSecret));
      return true;
    },
  );
});

test("fails on HTTP errors without reading or logging the response body", async () => {
  let bodyRead = false;
  await assert.rejects(
    callInternalSchedulerEndpoint({
      ...base,
      fetchImpl: async (_url, options) => {
        assert.equal(options.method, "POST");
        assert.equal(options.headers.Authorization, `Bearer ${base.cronSecret}`);
        return {
          status: 401,
          get text() { bodyRead = true; return async () => "private response details"; },
        };
      },
    }),
    /automation-sweep: returned HTTP 401/,
  );
  assert.equal(bodyRead, false);
});

test("treats redirects as failures instead of following them", async () => {
  const status = await callInternalSchedulerEndpoint({
    ...base,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return { status: 302 };
    },
  }).then(
    () => assert.fail("expected the redirect to fail"),
    (error) => error.message,
  );
  assert.match(status, /returned HTTP 302/);
});

test("accepts a 2xx response and uses the configured endpoint", async () => {
  const status = await callInternalSchedulerEndpoint({
    ...base,
    fetchImpl: async (url, options) => {
      assert.equal(url.href, "https://backend.example/api/internal/jobs/automation-sweep");
      assert.equal(options.method, "POST");
      return { status: 204 };
    },
  });
  assert.equal(status, 204);
});
