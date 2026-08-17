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

async function post(endpoint: string, body: unknown, token = authToken) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": token },
    body: JSON.stringify(body),
  });
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
    maxConcurrency: 2,
    maxRequestBytes: 524_288,
    containerRuntime: runtime,
    javascriptImage,
    pythonImage,
    egressNetwork: null,
    cpuLimit: 1,
    pidsLimit: 32,
    tmpfsMb: 8,
  };
  const server = await startSandboxRunner(config);
  try {
    const address = server.address() as AddressInfo;
    const executeUrl = `http://127.0.0.1:${address.port}/execute`;
    process.env.SKILL_SECRET_SANDBOX_RUNNER_TOKEN = authToken;

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
    }, null, 2));
  } finally {
    delete process.env.SKILL_SECRET_SANDBOX_RUNNER_TOKEN;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
