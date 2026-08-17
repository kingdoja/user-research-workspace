import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const protocol = "atypica.sandbox/v1";
const baseUrlValue = process.env.SANDBOX_VERIFY_URL?.trim();
const authToken = process.env.SANDBOX_VERIFY_TOKEN ?? "";
const metricsAuthToken = process.env.SANDBOX_VERIFY_METRICS_TOKEN ?? authToken;
const allowHttp = process.env.SANDBOX_VERIFY_ALLOW_HTTP === "1";

if (!baseUrlValue) throw new Error("SANDBOX_VERIFY_URL is required");
let baseUrl: URL;
try {
  baseUrl = new URL(baseUrlValue);
} catch {
  throw new Error("SANDBOX_VERIFY_URL must be a valid URL");
}
if (baseUrl.protocol !== "https:" && !(allowHttp && baseUrl.protocol === "http:")) {
  throw new Error("SANDBOX_VERIFY_URL must use HTTPS (set SANDBOX_VERIFY_ALLOW_HTTP=1 only for local checks)");
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error("SANDBOX_VERIFY_URL must be an origin without credentials, query, or fragment");
}
if (authToken.length < 24) {
  throw new Error("SANDBOX_VERIFY_TOKEN must contain at least 24 characters");
}
if (metricsAuthToken.length < 24) {
  throw new Error("SANDBOX_VERIFY_METRICS_TOKEN must contain at least 24 characters");
}

const healthUrl = new URL("/health", baseUrl);
const liveUrl = new URL("/live", baseUrl);
const readyUrl = new URL("/ready", baseUrl);
const metricsUrl = new URL("/metrics", baseUrl);
const executeUrl = new URL("/execute", baseUrl);

function executionRequest(input: {
  language: "javascript" | "python";
  entrypoint: string;
  source: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  networkAccess?: boolean;
}) {
  return {
    protocol,
    runtime: { language: input.language, entrypoint: input.entrypoint },
    files: { [input.entrypoint]: input.source },
    input: { left: 6, right: 7 },
    limits: {
      timeoutMs: input.timeoutMs ?? 15_000,
      maxMemoryMb: 64,
      maxOutputBytes: input.maxOutputBytes ?? 64_000,
      networkAccess: input.networkAccess ?? false,
    },
  };
}

async function execute(body: unknown, token = authToken) {
  return fetch(executeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": token },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(140_000),
  });
}

async function json(response: Response) {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}

async function assertNoLocalContainers() {
  const runtime = process.env.SANDBOX_VERIFY_CONTAINER_RUNTIME;
  if (!runtime) return "not_checked" as const;
  if (runtime !== "docker" && runtime !== "podman") {
    throw new Error("SANDBOX_VERIFY_CONTAINER_RUNTIME must be docker or podman");
  }
  const child = spawn(runtime, ["ps", "-aq", "--filter", "label=ai.atypica.sandbox=true"], {
    shell: false,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const [exitCode] = await once(child, "close") as [number];
  assert.equal(exitCode, 0, `${runtime} container inspection failed`);
  assert.equal(Buffer.concat(chunks).toString("utf8").trim(), "", "Sandbox containers remain after verification");
  return "passed" as const;
}

async function main() {
  const liveResponse = await fetch(liveUrl, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  const live = await json(liveResponse);
  assert.equal(liveResponse.status, 200);
  assert.deepEqual(live, { protocol, status: "live" });

  for (const endpoint of [readyUrl, healthUrl]) {
    const readyResponse = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    const ready = await json(readyResponse);
    assert.equal(readyResponse.status, 200);
    assert.equal(ready.protocol, protocol);
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.runtimes, ["javascript", "python"]);
    assert.deepEqual(ready.imageDigestsPinned, { javascript: true, python: true });
    const checks = ready.checks as Record<string, unknown>;
    assert.equal(typeof checks.checkedAt, "string");
    assert.equal(checks.runtimeAvailable, true);
    assert.deepEqual(checks.imagesAvailable, { javascript: true, python: true });
  }

  const unauthorizedMetrics = await fetch(metricsUrl, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  assert.equal(unauthorizedMetrics.status, 401);
  assert.deepEqual(await json(unauthorizedMetrics), { error: "unauthorized" });

  const unauthorizedResponse = await execute(executionRequest({
    language: "javascript",
    entrypoint: "unauthorized.mjs",
    source: "export default () => ({ ok: true });",
  }), `${authToken}-invalid`);
  assert.equal(unauthorizedResponse.status, 401);
  assert.deepEqual(await json(unauthorizedResponse), { error: "unauthorized" });

  const javascriptResponse = await execute(executionRequest({
    language: "javascript",
    entrypoint: "verify.mjs",
    source: `import { readFileSync, writeFileSync } from "node:fs";
export default ({ left, right }) => {
  let workspaceReadOnly = false;
  try { writeFileSync("/workspace/mutation.txt", "denied"); } catch { workspaceReadOnly = true; }
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\\n").slice(1);
  const networkBlocked = !routes.some((line) => line.trim().split(/\\s+/)[1] === "00000000");
  return { sum: left + right, uid: process.getuid(), workspaceReadOnly, networkBlocked };
};`,
  }));
  const javascript = await json(javascriptResponse);
  assert.equal(javascriptResponse.status, 200);
  assert.equal(javascript.status, "completed");
  assert.deepEqual(javascript.output, { sum: 13, uid: 65532, workspaceReadOnly: true, networkBlocked: true });

  const pythonResponse = await execute(executionRequest({
    language: "python",
    entrypoint: "verify.py",
    source: "def main(value):\n    return {'product': value['left'] * value['right']}\n",
  }));
  const python = await json(pythonResponse);
  assert.equal(pythonResponse.status, 200);
  assert.equal(python.status, "completed");
  assert.deepEqual(python.output, { product: 42 });

  const timeoutResponse = await execute(executionRequest({
    language: "javascript",
    entrypoint: "timeout.mjs",
    source: "export default async () => await new Promise((resolve) => setTimeout(resolve, 10000));",
    timeoutMs: 1_000,
  }));
  const timeout = await json(timeoutResponse);
  assert.equal(timeout.status, "failed");
  assert.equal(timeout.errorCode, "SANDBOX_TIMEOUT");

  const outputResponse = await execute(executionRequest({
    language: "javascript",
    entrypoint: "output.mjs",
    source: "export default () => ({ value: 'x'.repeat(10000) });",
    maxOutputBytes: 1_024,
  }));
  const output = await json(outputResponse);
  assert.equal(output.status, "failed");
  assert.equal(output.errorCode, "SANDBOX_OUTPUT_LIMIT");

  const networkResponse = await execute(executionRequest({
    language: "javascript",
    entrypoint: "network.mjs",
    source: "export default () => ({ ok: true });",
    networkAccess: true,
  }));
  const network = await json(networkResponse);
  assert.equal(network.status, "failed");
  assert.equal(network.errorCode, "SANDBOX_NETWORK_DISABLED");

  const residualContainers = await assertNoLocalContainers();
  const metricsResponse = await fetch(metricsUrl, {
    headers: { authorization: `Bearer ${metricsAuthToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const metrics = await metricsResponse.text();
  assert.equal(metricsResponse.status, 200);
  assert.match(metrics, /atypica_sandbox_runner_ready 1/);
  assert.match(metrics, /atypica_sandbox_runner_executions_accepted_total [1-9][0-9]*/);
  assert.match(metrics, /code="SANDBOX_TIMEOUT"/);
  assert.equal(metrics.includes(authToken), false);
  assert.equal(metrics.includes(metricsAuthToken), false);
  assert.doesNotMatch(metrics, /executionId|sbx_|verify\.mjs|verify\.py/);
  console.log(JSON.stringify({
    target: baseUrl.origin,
    protocol,
    liveness: "passed",
    readiness: "passed",
    healthCompatibility: "passed",
    authenticatedMetrics: "passed",
    imageDigestsPinned: "passed",
    authentication: "passed",
    javascriptIsolation: "passed",
    pythonExecution: "passed",
    timeoutLimit: "passed",
    outputLimit: "passed",
    defaultNetworkDeny: "passed",
    residualContainers,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
