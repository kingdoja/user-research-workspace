import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { executeConfiguredSkill, SkillExecutionError } from "../src/lib/skill-executor";
import { loadSandboxRunnerConfig, type SandboxRunnerConfig } from "../services/sandbox-runner/config";
import { startSandboxRunner } from "../services/sandbox-runner/server";

const runtime = process.env.SANDBOX_CONTAINER_RUNTIME === "podman" ? "podman" : "docker";
const javascriptImage = process.env.SANDBOX_JAVASCRIPT_IMAGE ?? "node:24-alpine";
const pythonImage = process.env.SANDBOX_PYTHON_IMAGE ?? "python:3.13-alpine";
const authToken = "sandbox-smoke-token-000000000000";

async function assertImageAvailable(image: string) {
  const child = spawn(runtime, ["image", "inspect", image], { stdio: "ignore", shell: false });
  const [code] = await once(child, "close") as [number];
  if (code !== 0) throw new Error(`Pre-pull sandbox runtime image: ${image}`);
}

async function assertNoSandboxContainers() {
  const child = spawn(runtime, ["ps", "-aq", "--filter", "label=ai.atypica.sandbox=true"], {
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const [code] = await once(child, "close") as [number];
  assert.equal(code, 0);
  assert.equal(Buffer.concat(chunks).toString("utf8").trim(), "");
}

async function post(endpoint: string, body: unknown, token = authToken) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": token },
    body: JSON.stringify(body),
  });
}

async function waitForActive(baseUrl: string, expected: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json() as { activeExecutions: number };
    if (body.activeExecutions === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Runner did not reach ${expected} active execution(s)`);
}

function request(input: {
  language: "javascript" | "python";
  entrypoint: string;
  files: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  networkAccess?: boolean;
}) {
  return {
    protocol: "atypica.sandbox/v1",
    runtime: { language: input.language, entrypoint: input.entrypoint },
    files: input.files,
    input: { left: 6, right: 7 },
    limits: {
      timeoutMs: input.timeoutMs ?? 15_000,
      maxMemoryMb: 64,
      maxOutputBytes: input.maxOutputBytes ?? 64_000,
      networkAccess: input.networkAccess ?? false,
    },
  };
}

async function main() {
  assert.throws(() => loadSandboxRunnerConfig({
    NODE_ENV: "production",
    SANDBOX_RUNNER_AUTH_TOKEN: authToken,
    SANDBOX_JAVASCRIPT_IMAGE: "node:24-alpine",
    SANDBOX_PYTHON_IMAGE: "python:3.13-alpine",
  }), /pinned by sha256 digest/);
  assert.throws(() => loadSandboxRunnerConfig({
    NODE_ENV: "development",
    SANDBOX_RUNNER_AUTH_TOKEN: "short",
  }), /at least 24 characters/);
  await Promise.all([assertImageAvailable(javascriptImage), assertImageAvailable(pythonImage)]);
  const config: SandboxRunnerConfig = {
    host: "127.0.0.1",
    port: 0,
    authToken,
    maxConcurrency: 1,
    maxRequestBytes: 524_288,
    containerRuntime: runtime,
    javascriptImage,
    pythonImage,
    egressNetwork: null,
    cpuLimit: 1,
    pidsLimit: 32,
    tmpfsMb: 8,
    shutdownGraceMs: 5_000,
    readinessProbeIntervalMs: 60_000,
    readinessProbeTimeoutMs: 5_000,
  };
  const server = await startSandboxRunner(config);
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const executeUrl = `http://127.0.0.1:${address.port}/execute`;
    process.env.SKILL_SECRET_SANDBOX_RUNNER_TOKEN = authToken;

    const liveResponse = await fetch(`${baseUrl}/live`);
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(await liveResponse.json(), { protocol: "atypica.sandbox/v1", status: "live" });
    for (const path of ["ready", "health"]) {
      const readyResponse = await fetch(`${baseUrl}/${path}`);
      const ready = await readyResponse.json() as {
        status: string;
        checks: { runtimeAvailable: boolean; imagesAvailable: { javascript: boolean; python: boolean } };
      };
      assert.equal(readyResponse.status, 200);
      assert.equal(ready.status, "ready");
      assert.equal(ready.checks.runtimeAvailable, true);
      assert.deepEqual(ready.checks.imagesAvailable, { javascript: true, python: true });
    }
    const unauthorizedMetrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(unauthorizedMetrics.status, 401);
    assert.deepEqual(await unauthorizedMetrics.json(), { error: "unauthorized" });

    const javascript = await executeConfiguredSkill({
      config: {
        kind: "sandbox",
        endpoint: executeUrl,
        language: "javascript",
        entrypoint: "index.mjs",
        files: {
          "index.mjs": `import { readFileSync, writeFileSync } from "node:fs";
export default async ({ left, right }) => {
  let workspaceReadOnly = false;
  try { writeFileSync("/workspace/mutation.txt", "denied"); } catch { workspaceReadOnly = true; }
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\\n").slice(1);
  const networkBlocked = !routes.some((line) => line.trim().split(/\\s+/)[1] === "00000000");
  return { sum: left + right, workspaceReadOnly, networkBlocked, uid: process.getuid() };
};`,
        },
        timeoutMs: 15_000,
        maxResponseBytes: 64_000,
        headersFromEnv: { "x-sandbox-token": "SKILL_SECRET_SANDBOX_RUNNER_TOKEN" },
        maxMemoryMb: 64,
        networkAccess: false,
      },
      inputSchema: { type: "object", required: ["left", "right"] },
      outputSchema: {
        type: "object",
        required: ["sum", "workspaceReadOnly", "networkBlocked", "uid"],
        properties: {
          sum: { const: 13 }, workspaceReadOnly: { const: true }, networkBlocked: { const: true }, uid: { const: 65532 },
        },
      },
      arguments: { left: 6, right: 7 },
    });
    assert.deepEqual(javascript, { sum: 13, workspaceReadOnly: true, networkBlocked: true, uid: 65532 });

    const pythonResponse = await post(executeUrl, request({
      language: "python",
      entrypoint: "main.py",
      files: { "main.py": "def main(value):\n    print('python log')\n    return {'product': value['left'] * value['right']}\n" },
    }));
    const python = await pythonResponse.json() as { status: string; output: { product: number } };
    assert.equal(pythonResponse.status, 200);
    assert.equal(python.status, "completed");
    assert.deepEqual(python.output, { product: 42 });

    const unauthorized = await post(executeUrl, request({
      language: "javascript", entrypoint: "index.mjs", files: { "index.mjs": "export default () => ({ ok: true });" },
    }), "wrong-token");
    assert.equal(unauthorized.status, 401);

    const invalidPath = await post(executeUrl, request({
      language: "javascript", entrypoint: "../escape.mjs", files: { "../escape.mjs": "export default () => ({});" },
    }));
    assert.equal(invalidPath.status, 400);

    await assert.rejects(
      executeConfiguredSkill({
        config: {
          kind: "sandbox", endpoint: executeUrl, language: "javascript", entrypoint: "wait.mjs",
          files: { "wait.mjs": "export default async () => await new Promise((resolve) => setTimeout(resolve, 10000));" },
          timeoutMs: 1_000, maxResponseBytes: 64_000,
          headersFromEnv: { "x-sandbox-token": "SKILL_SECRET_SANDBOX_RUNNER_TOKEN" },
          maxMemoryMb: 64, networkAccess: false,
        },
        inputSchema: { type: "object" }, outputSchema: { type: "object" }, arguments: {},
      }),
      (error: unknown) => error instanceof SkillExecutionError && error.code === "SANDBOX_TIMEOUT",
    );

    const outputResponse = await post(executeUrl, request({
      language: "javascript", entrypoint: "large.mjs", maxOutputBytes: 1_024,
      files: { "large.mjs": "export default () => ({ value: 'x'.repeat(10000) });" },
    }));
    const outputLimit = await outputResponse.json() as { errorCode: string };
    assert.equal(outputLimit.errorCode, "SANDBOX_OUTPUT_LIMIT");

    const networkResponse = await post(executeUrl, request({
      language: "javascript", entrypoint: "network.mjs", networkAccess: true,
      files: { "network.mjs": "export default () => ({ ok: true });" },
    }));
    const network = await networkResponse.json() as { errorCode: string };
    assert.equal(network.errorCode, "SANDBOX_NETWORK_DISABLED");

    await assert.rejects(
      executeConfiguredSkill({
        config: {
          kind: "sandbox", endpoint: executeUrl, language: "javascript", entrypoint: "index.mjs",
          files: { "index.mjs": "export default () => ({ ok: true });" }, timeoutMs: 5_000,
          maxResponseBytes: 64_000, headersFromEnv: { "x-sandbox-token": "SKILL_SECRET_SANDBOX_RUNNER_TOKEN" },
          maxMemoryMb: 64, networkAccess: true,
        },
        inputSchema: { type: "object" }, outputSchema: { type: "object" }, arguments: {},
      }),
      (error: unknown) => error instanceof SkillExecutionError && error.code === "SANDBOX_NETWORK_DISABLED",
    );

    const busyExecution = post(executeUrl, request({
      language: "javascript",
      entrypoint: "busy.mjs",
      files: { "busy.mjs": "export default async () => { await new Promise((resolve) => setTimeout(resolve, 500)); return { done: true }; };" },
    }));
    await waitForActive(baseUrl, 1);
    const busyResponse = await post(executeUrl, request({
      language: "javascript", entrypoint: "busy-rejected.mjs", files: { "busy-rejected.mjs": "export default () => ({ ok: true });" },
    }));
    assert.equal(busyResponse.status, 429);
    assert.deepEqual(await busyResponse.json(), { error: "runner_busy" });
    assert.equal((await busyExecution).status, 200);

    const metricsResponse = await fetch(`${baseUrl}/metrics`, { headers: { "x-sandbox-token": authToken } });
    const metrics = await metricsResponse.text();
    assert.equal(metricsResponse.status, 200);
    assert.match(metricsResponse.headers.get("content-type") ?? "", /^text\/plain/);
    assert.match(metrics, /atypica_sandbox_runner_executions_accepted_total 7/);
    assert.match(metrics, /atypica_sandbox_runner_executions_completed_total 3/);
    assert.match(metrics, /atypica_sandbox_runner_executions_failed_total 4/);
    assert.match(metrics, /code="SANDBOX_TIMEOUT"/);
    assert.match(metrics, /reason="busy"/);
    assert.doesNotMatch(metrics, new RegExp(authToken));
    assert.doesNotMatch(metrics, /large\.mjs|index\.mjs|executionId|sbx_/);

    const drainingExecution = post(executeUrl, request({
      language: "javascript",
      entrypoint: "drain.mjs",
      files: { "drain.mjs": "export default async () => { await new Promise((resolve) => setTimeout(resolve, 750)); return { drained: true }; };" },
    }));
    await waitForActive(baseUrl, 1);
    const draining = server.beginDrain();
    const rejectedDuringDrain = await post(executeUrl, request({
      language: "javascript", entrypoint: "rejected.mjs", files: { "rejected.mjs": "export default () => ({ ok: true });" },
    }));
    assert.equal(rejectedDuringDrain.status, 503);
    assert.deepEqual(await rejectedDuringDrain.json(), { error: "runner_draining" });
    const drainingResponse = await drainingExecution;
    const drainingResult = await drainingResponse.json() as { status: string; output: { drained: boolean } };
    assert.equal(drainingResult.status, "completed");
    assert.deepEqual(drainingResult.output, { drained: true });
    assert.equal(await draining, "drained");

    console.log(JSON.stringify({
      protocol: "atypica.sandbox/v1",
      javascriptAndPython: true,
      nonRootReadOnly: true,
      defaultNetworkDenied: true,
      authentication: true,
      pathTraversalRejected: true,
      timeoutEnforced: true,
      outputLimitEnforced: true,
      productionDigestPinning: true,
      noHostExecutionFallback: true,
      runtimeReadiness: true,
      authenticatedMetrics: true,
      concurrencyAdmission: true,
      gracefulDrain: true,
    }, null, 2));
  } finally {
    delete process.env.SKILL_SECRET_SANDBOX_RUNNER_TOKEN;
    if (server.listening) await server.beginDrain();
  }

  const unavailableServer = await startSandboxRunner({
    ...config,
    port: 0,
    javascriptImage: "atypica/readiness-image-does-not-exist:smoke",
  });
  try {
    const address = unavailableServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const readyResponse = await fetch(`${baseUrl}/ready`);
    const ready = await readyResponse.json() as { status: string; checks: { imagesAvailable: { javascript: boolean } } };
    assert.equal(readyResponse.status, 503);
    assert.equal(ready.status, "unavailable");
    assert.equal(ready.checks.imagesAvailable.javascript, false);
    const unavailableResponse = await post(`${baseUrl}/execute`, request({
      language: "javascript", entrypoint: "unavailable.mjs", files: { "unavailable.mjs": "export default () => ({ ok: true });" },
    }));
    assert.equal(unavailableResponse.status, 503);
    assert.deepEqual(await unavailableResponse.json(), { error: "runner_unavailable" });
  } finally {
    await unavailableServer.beginDrain();
  }

  const forcedServer = await startSandboxRunner({ ...config, port: 0, shutdownGraceMs: 1_000 });
  try {
    const address = forcedServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const forcedExecution = post(`${baseUrl}/execute`, request({
      language: "javascript",
      entrypoint: "forced.mjs",
      files: { "forced.mjs": "export default async () => await new Promise((resolve) => setTimeout(() => resolve({ unexpected: true }), 10000));" },
      timeoutMs: 15_000,
    }));
    await waitForActive(baseUrl, 1);
    const forcedDrain = forcedServer.beginDrain();
    const response = await forcedExecution;
    const result = await response.json() as { status: string; errorCode: string };
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "SANDBOX_SHUTDOWN");
    assert.equal(await forcedDrain, "forced");
    console.log(JSON.stringify({ forcedDrainCleanup: true }, null, 2));
  } finally {
    if (forcedServer.listening) await forcedServer.beginDrain();
  }
  await assertNoSandboxContainers();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
