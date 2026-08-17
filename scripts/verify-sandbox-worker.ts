import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const unitName = "atypica-sandbox-runner.service";

function parseEnvironmentFile(content: string) {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error("Runner environment file contains an unsupported line");
    values.set(match[1], match[2]);
  }
  return values;
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value) throw new Error(`${key} is required in the Runner environment file`);
  return value;
}

function run(command: string, args: string[], timeoutMs = 10_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8").trim());
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = 64_000 - stdoutBytes;
      if (remaining <= 0) return;
      const value = chunk.subarray(0, remaining);
      stdout.push(value);
      stdoutBytes += value.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 8_000 - stderrBytes;
      if (remaining <= 0) return;
      const value = chunk.subarray(0, remaining);
      stderr.push(value);
      stderrBytes += value.byteLength;
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(code === 0
      ? undefined
      : new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 500)}`)));
  });
}

async function getJson(url: string) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return body;
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("verify:sandbox-worker must run on the dedicated Linux worker");
  }
  const environmentPath = process.env.SANDBOX_WORKER_ENV_FILE
    ?? join(homedir(), ".config/atypica/sandbox-runner.env");
  const file = await stat(environmentPath);
  assert.equal(file.isFile(), true, "Runner environment path must be a regular file");
  assert.equal(file.mode & 0o077, 0, "Runner environment file must not be accessible by group or others");

  const values = parseEnvironmentFile(await readFile(environmentPath, "utf8"));
  assert.equal(required(values, "NODE_ENV"), "production");
  assert.equal(required(values, "SANDBOX_RUNNER_HOST"), "127.0.0.1");
  assert.equal(required(values, "SANDBOX_CONTAINER_RUNTIME"), "podman");
  assert.equal(required(values, "SANDBOX_RUNNER_REQUIRE_IMAGE_DIGEST"), "1");
  const authToken = required(values, "SANDBOX_RUNNER_AUTH_TOKEN");
  const metricsToken = required(values, "SANDBOX_RUNNER_METRICS_AUTH_TOKEN");
  assert.ok(authToken.length >= 32 && !authToken.includes("CHANGE_ME"), "Runner auth token is still a placeholder");
  assert.ok(metricsToken.length >= 32 && !metricsToken.includes("CHANGE_ME"), "Metrics auth token is still a placeholder");
  if (authToken === metricsToken) throw new Error("Execution and metrics tokens must be different");

  const javascriptImage = required(values, "SANDBOX_JAVASCRIPT_IMAGE");
  const pythonImage = required(values, "SANDBOX_PYTHON_IMAGE");
  const digestPattern = /@sha256:[a-f0-9]{64}$/;
  assert.match(javascriptImage, digestPattern);
  assert.match(pythonImage, digestPattern);
  assert.equal(await run("podman", ["info", "--format", "{{.Host.Security.Rootless}}"]), "true");
  await Promise.all([
    run("podman", ["image", "inspect", javascriptImage]),
    run("podman", ["image", "inspect", pythonImage]),
  ]);
  assert.equal(await run("systemctl", ["--user", "is-enabled", unitName]), "enabled");
  assert.equal(await run("systemctl", ["--user", "is-active", unitName]), "active");

  const port = Number(required(values, "SANDBOX_RUNNER_PORT"));
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65_535, "Runner port is invalid");
  const baseUrl = `http://127.0.0.1:${port}`;
  assert.deepEqual(await getJson(`${baseUrl}/live`), { protocol: "atypica.sandbox/v1", status: "live" });
  const ready = await getJson(`${baseUrl}/ready`);
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.imageDigestsPinned, { javascript: true, python: true });
  const executionTokenMetrics = await fetch(`${baseUrl}/metrics`, {
    headers: { "x-sandbox-token": authToken },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(executionTokenMetrics.status, 401, "Execution token must not authorize metrics");
  await executionTokenMetrics.body?.cancel();
  const metricsResponse = await fetch(`${baseUrl}/metrics`, {
    headers: { authorization: `Bearer ${metricsToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const metrics = await metricsResponse.text();
  assert.equal(metricsResponse.status, 200);
  assert.match(metrics, /atypica_sandbox_runner_ready 1/);
  assert.equal(metrics.includes(authToken), false);
  assert.equal(metrics.includes(metricsToken), false);

  console.log(JSON.stringify({
    platform: "linux",
    environmentFileMode: (file.mode & 0o777).toString(8),
    rootlessPodman: true,
    pinnedImages: true,
    distinctCredentials: true,
    systemdEnabledAndActive: true,
    localLiveness: true,
    localReadiness: true,
    authenticatedMetrics: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
