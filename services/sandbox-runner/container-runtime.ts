import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SandboxRunnerConfig } from "./config";
import {
  SANDBOX_PROTOCOL,
  type SandboxExecutionRequest,
  type SandboxExecutionResponse,
} from "./protocol";

type ProcessResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  termination: "timeout" | "output_limit" | "shutdown" | null;
};

export type ContainerRuntimeReadiness = {
  ready: boolean;
  checkedAt: string;
  runtimeAvailable: boolean;
  imagesAvailable: {
    javascript: boolean;
    python: boolean;
  };
};

function runtimeCheck(runtime: SandboxRunnerConfig["containerRuntime"], args: string[], timeoutMs: number) {
  return new Promise<boolean>((resolvePromise) => {
    const child = spawn(runtime, args, { stdio: "ignore", shell: false });
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(false);
    }, timeoutMs);
    child.once("error", () => settle(false));
    child.once("close", (code) => settle(code === 0));
  });
}

export async function probeContainerRuntime(config: SandboxRunnerConfig): Promise<ContainerRuntimeReadiness> {
  const runtimeAvailable = await runtimeCheck(config.containerRuntime, ["info"], config.readinessProbeTimeoutMs);
  const [javascript, python] = runtimeAvailable
    ? await Promise.all([
      runtimeCheck(config.containerRuntime, ["image", "inspect", config.javascriptImage], config.readinessProbeTimeoutMs),
      runtimeCheck(config.containerRuntime, ["image", "inspect", config.pythonImage], config.readinessProbeTimeoutMs),
    ])
    : [false, false];
  return {
    ready: runtimeAvailable && javascript && python,
    checkedAt: new Date().toISOString(),
    runtimeAvailable,
    imagesAvailable: { javascript, python },
  };
}

function boundedMessage(value: Buffer) {
  return value.toString("utf8").replaceAll(/\/workspace\/[A-Za-z0-9._/-]+/g, "/workspace/<redacted>").slice(0, 1_200);
}

function runtimeCommand(config: SandboxRunnerConfig, args: string[], timeoutMs = 5_000) {
  return new Promise<void>((resolve) => {
    const child = spawn(config.containerRuntime, args, { stdio: "ignore", shell: false });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runContainerProcess(input: {
  config: SandboxRunnerConfig;
  args: string[];
  stdin: string;
  containerName: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}) {
  return new Promise<ProcessResult>((resolvePromise) => {
    const child = spawn(input.config.containerRuntime, input.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let termination: ProcessResult["termination"] = null;
    let settled = false;

    const terminate = (reason: Exclude<ProcessResult["termination"], null>) => {
      if (termination) return;
      termination = reason;
      child.stdin.destroy();
      child.kill("SIGKILL");
      settle(null);
    };
    const timer = setTimeout(() => terminate("timeout"), input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > input.maxOutputBytes) terminate("output_limit");
      else stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 65_536) return;
      const remaining = 65_536 - stderrBytes;
      stderrChunks.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.byteLength, remaining);
    });
    const settle = (exitCode: number | null, extraError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (extraError) stderrChunks.push(Buffer.from(extraError));
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        termination,
      });
    };
    const abort = () => terminate("shutdown");
    child.once("error", (error) => settle(null, error.message));
    child.once("close", (code) => settle(code));
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    child.stdin.end(input.stdin);
  });
}

async function writeWorkspace(root: string, request: SandboxExecutionRequest) {
  await chmod(root, 0o755);
  for (const [relativePath, content] of Object.entries(request.files)) {
    const target = resolve(root, relativePath);
    if (!target.startsWith(`${root}/`)) throw new Error("Sandbox path escaped workspace");
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, content, { encoding: "utf8", mode: 0o444, flag: "wx" });
  }
  const runtimeDirectory = join(root, ".atypica");
  await mkdir(runtimeDirectory, { mode: 0o755 });
  const runtimeSource = request.runtime.language === "javascript"
    ? new URL("./runtime/javascript-runner.mjs", import.meta.url)
    : new URL("./runtime/python_runner.py", import.meta.url);
  const runtimeContent = await import("node:fs/promises").then(({ readFile }) => readFile(runtimeSource, "utf8"));
  const runtimeTarget = join(runtimeDirectory, request.runtime.language === "javascript" ? "runner.mjs" : "runner.py");
  await writeFile(runtimeTarget, runtimeContent, { encoding: "utf8", mode: 0o444, flag: "wx" });
  if (request.runtime.language === "javascript") {
    await writeFile(join(root, "package.json"), '{"type":"module"}\n', { encoding: "utf8", mode: 0o444, flag: "wx" });
  }
}

function containerArguments(input: {
  config: SandboxRunnerConfig;
  request: SandboxExecutionRequest;
  workspace: string;
  containerName: string;
  executionId: string;
}) {
  const { config, request } = input;
  const image = request.runtime.language === "javascript" ? config.javascriptImage : config.pythonImage;
  const memory = `${request.limits.maxMemoryMb}m`;
  const network = request.limits.networkAccess ? config.egressNetwork : "none";
  if (!network) throw new Error("SANDBOX_NETWORK_DISABLED");
  const args = [
    "run", "--rm", "-i", "--pull", "never", "--name", input.containerName,
    "--label", "ai.atypica.sandbox=true",
    "--label", `ai.atypica.sandbox.execution=${input.executionId}`,
    "--network", network,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", String(config.pidsLimit), "--memory", memory, "--memory-swap", memory,
    "--cpus", String(config.cpuLimit), "--ulimit", "nofile=64:64", "--ulimit", "core=0:0",
    "--user", "65532:65532", "--workdir", "/workspace", "--hostname", "sandbox", "--init",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${config.tmpfsMb}m,mode=1777`,
    "--mount", `type=bind,src=${input.workspace},dst=/workspace,readonly`,
  ];
  if (request.runtime.language === "javascript") {
    args.push("--env", "NODE_OPTIONS=--disable-proto=throw", "--entrypoint", "node", image,
      "/workspace/.atypica/runner.mjs", `/workspace/${request.runtime.entrypoint}`);
  } else {
    args.push("--env", "PYTHONDONTWRITEBYTECODE=1", "--entrypoint", "python3", image,
      "/workspace/.atypica/runner.py", `/workspace/${request.runtime.entrypoint}`);
  }
  return args;
}

export async function executeInContainer(
  request: SandboxExecutionRequest,
  config: SandboxRunnerConfig,
  signal?: AbortSignal,
): Promise<SandboxExecutionResponse> {
  const startedAt = performance.now();
  const executionId = `sbx_${randomUUID().replaceAll("-", "")}`;
  const containerName = `atypica-sandbox-${executionId.slice(4, 20)}`;
  const workspace = await mkdtemp(join(tmpdir(), "atypica-sandbox-"));
  const response = (value: Omit<SandboxExecutionResponse, "protocol" | "executionId" | "metrics">): SandboxExecutionResponse => ({
    protocol: SANDBOX_PROTOCOL,
    executionId,
    ...value,
    metrics: { durationMs: Math.round(performance.now() - startedAt) },
  });
  try {
    if (request.limits.networkAccess && !config.egressNetwork) {
      return response({
        status: "failed",
        exitCode: null,
        errorCode: "SANDBOX_NETWORK_DISABLED",
        errorMessage: "Network execution requires an operator-controlled egress network",
      });
    }
    await writeWorkspace(workspace, request);
    const result = await runContainerProcess({
      config,
      args: containerArguments({ config, request, workspace, containerName, executionId }),
      stdin: JSON.stringify(request.input),
      containerName,
      timeoutMs: request.limits.timeoutMs,
      maxOutputBytes: request.limits.maxOutputBytes,
      signal,
    });
    if (result.termination === "timeout") {
      return response({ status: "failed", exitCode: result.exitCode, errorCode: "SANDBOX_TIMEOUT", errorMessage: "Execution timed out" });
    }
    if (result.termination === "output_limit") {
      return response({ status: "failed", exitCode: result.exitCode, errorCode: "SANDBOX_OUTPUT_LIMIT", errorMessage: "Execution output exceeded the configured limit" });
    }
    if (result.termination === "shutdown") {
      return response({ status: "failed", exitCode: result.exitCode, errorCode: "SANDBOX_SHUTDOWN", errorMessage: "Execution stopped because the runner is shutting down" });
    }
    if (result.exitCode !== 0) {
      return response({
        status: "failed",
        exitCode: result.exitCode,
        errorCode: result.exitCode === 137 ? "SANDBOX_RESOURCE_LIMIT" : "SANDBOX_RUNTIME_ERROR",
        errorMessage: boundedMessage(result.stderr) || `Runtime exited with code ${result.exitCode ?? "unknown"}`,
      });
    }
    try {
      return response({ status: "completed", exitCode: 0, output: JSON.parse(result.stdout.toString("utf8")) as unknown });
    } catch {
      return response({
        status: "failed",
        exitCode: 0,
        errorCode: "SANDBOX_OUTPUT_INVALID",
        errorMessage: "Runtime did not return one valid JSON value",
      });
    }
  } catch (error) {
    return response({
      status: "failed",
      exitCode: null,
      errorCode: "SANDBOX_RUNNER_ERROR",
      errorMessage: error instanceof Error ? error.message.slice(0, 1_200) : "Sandbox runner failed",
    });
  } finally {
    await runtimeCommand(config, ["rm", "-f", containerName]);
    await rm(workspace, { recursive: true, force: true });
  }
}
