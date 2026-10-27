import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Invoke one internal scheduler endpoint without logging credentials or its
 * response body. The body can contain operational data and is not needed to
 * distinguish success from HTTP, DNS, connection, or timeout failures.
 */
export async function callInternalSchedulerEndpoint({
  name,
  path,
  baseUrl,
  cronSecret,
  fetchImpl = fetch,
}) {
  if (!cronSecret) {
    throw new Error(`${name}: CRON_SECRET is unavailable; endpoint was not called`);
  }
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("scheduler endpoint name is required");
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(`${name}: endpoint path must be an absolute path`);
  }

  let url;
  try {
    url = new URL(path, baseUrl);
  } catch {
    throw new Error(`${name}: BASE_URL or endpoint path is invalid`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name}: BASE_URL must use HTTP or HTTPS`);
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${name}: request failed before an HTTP response`);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${name}: returned HTTP ${response.status}`);
  }
  return response.status;
}

async function main() {
  const [name, path, ...extra] = process.argv.slice(2);
  if (!name || !path || extra.length > 0) {
    console.error("::error::usage: node scripts/call-internal-scheduler-endpoint.mjs <endpoint-name> </path>");
    process.exitCode = 2;
    return;
  }

  try {
    const status = await callInternalSchedulerEndpoint({
      name,
      path,
      baseUrl: process.env.BASE_URL,
      cronSecret: process.env.CRON_SECRET,
    });
    console.log(`${name}: returned HTTP ${status}`);
  } catch (error) {
    // Error messages above are deliberately built from non-secret endpoint
    // metadata only. Do not print request headers, response bodies, or causes.
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
