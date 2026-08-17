import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  executeInContainer,
  probeContainerRuntime,
  type ContainerRuntimeReadiness,
} from "./container-runtime";
import { loadSandboxRunnerConfig, type SandboxRunnerConfig } from "./config";
import { SANDBOX_PROTOCOL, sandboxExecutionRequestSchema } from "./protocol";

type DrainOutcome = "drained" | "forced";

export type SandboxRunnerServer = Server & {
  beginDrain: () => Promise<DrainOutcome>;
  refreshReadiness: () => Promise<ContainerRuntimeReadiness>;
};

type RunnerMetrics = {
  accepted: number;
  completed: number;
  failed: number;
  durationSecondsSum: number;
  durationCount: number;
  readinessProbeFailures: number;
  rejected: Map<string, number>;
  executionErrors: Map<string, number>;
};

function writeJson(response: ServerResponse, status: number, body: unknown) {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(content),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function writeMetrics(response: ServerResponse, content: string) {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(content),
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function tokenMatches(provided: string | undefined, expectedToken: string) {
  if (!provided) return false;
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function authenticated(request: IncomingMessage, expectedToken: string) {
  const provided = request.headers["x-sandbox-token"];
  return typeof provided === "string" && tokenMatches(provided, expectedToken);
}

function metricsAuthenticated(request: IncomingMessage, expectedToken: string) {
  const authorization = request.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  const sandboxToken = request.headers["x-sandbox-token"];
  return tokenMatches(authorization, expectedToken)
    || (typeof sandboxToken === "string" && tokenMatches(sandboxToken, expectedToken));
}

function readRequestBody(request: IncomingMessage, limit: number) {
  return new Promise<string>((resolve, reject) => {
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (declaredLength > limit) {
      request.resume();
      reject(new Error("REQUEST_TOO_LARGE"));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.byteLength;
      if (total > limit) {
        rejected = true;
        request.removeAllListeners("data");
        request.resume();
        reject(new Error("REQUEST_TOO_LARGE"));
      } else {
        chunks.push(chunk);
      }
    });
    request.once("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", reject);
  });
}

function increment(values: Map<string, number>, key: string) {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function safeErrorCode(value: string | undefined) {
  return value && /^SANDBOX_[A-Z_]{1,64}$/.test(value) ? value : "SANDBOX_UNKNOWN";
}

function readinessBody(input: {
  readiness: ContainerRuntimeReadiness;
  draining: boolean;
  activeExecutions: number;
  config: SandboxRunnerConfig;
}) {
  const ready = input.readiness.ready && !input.draining;
  return {
    protocol: SANDBOX_PROTOCOL,
    status: ready ? "ready" : input.draining ? "draining" : "unavailable",
    activeExecutions: input.activeExecutions,
    maxConcurrency: input.config.maxConcurrency,
    runtimes: ["javascript", "python"],
    imageDigestsPinned: {
      javascript: input.config.javascriptImage.includes("@sha256:"),
      python: input.config.pythonImage.includes("@sha256:"),
    },
    checks: {
      checkedAt: input.readiness.checkedAt,
      runtimeAvailable: input.readiness.runtimeAvailable,
      imagesAvailable: input.readiness.imagesAvailable,
    },
  };
}

function renderMetrics(input: {
  metrics: RunnerMetrics;
  activeExecutions: number;
  ready: boolean;
  draining: boolean;
}) {
  const lines = [
    "# HELP atypica_sandbox_runner_active_executions Current sandbox executions.",
    "# TYPE atypica_sandbox_runner_active_executions gauge",
    `atypica_sandbox_runner_active_executions ${input.activeExecutions}`,
    "# HELP atypica_sandbox_runner_ready Whether the runner can accept executions.",
    "# TYPE atypica_sandbox_runner_ready gauge",
    `atypica_sandbox_runner_ready ${input.ready ? 1 : 0}`,
    "# HELP atypica_sandbox_runner_draining Whether graceful shutdown has started.",
    "# TYPE atypica_sandbox_runner_draining gauge",
    `atypica_sandbox_runner_draining ${input.draining ? 1 : 0}`,
    "# HELP atypica_sandbox_runner_executions_accepted_total Accepted sandbox executions.",
    "# TYPE atypica_sandbox_runner_executions_accepted_total counter",
    `atypica_sandbox_runner_executions_accepted_total ${input.metrics.accepted}`,
    "# HELP atypica_sandbox_runner_executions_completed_total Completed sandbox executions.",
    "# TYPE atypica_sandbox_runner_executions_completed_total counter",
    `atypica_sandbox_runner_executions_completed_total ${input.metrics.completed}`,
    "# HELP atypica_sandbox_runner_executions_failed_total Failed sandbox executions.",
    "# TYPE atypica_sandbox_runner_executions_failed_total counter",
    `atypica_sandbox_runner_executions_failed_total ${input.metrics.failed}`,
    "# HELP atypica_sandbox_runner_execution_duration_seconds Sandbox execution duration.",
    "# TYPE atypica_sandbox_runner_execution_duration_seconds summary",
    `atypica_sandbox_runner_execution_duration_seconds_sum ${input.metrics.durationSecondsSum.toFixed(6)}`,
    `atypica_sandbox_runner_execution_duration_seconds_count ${input.metrics.durationCount}`,
    "# HELP atypica_sandbox_runner_readiness_probe_failures_total Failed runtime readiness probes.",
    "# TYPE atypica_sandbox_runner_readiness_probe_failures_total counter",
    `atypica_sandbox_runner_readiness_probe_failures_total ${input.metrics.readinessProbeFailures}`,
    "# HELP atypica_sandbox_runner_rejections_total Rejected execution requests by bounded reason.",
    "# TYPE atypica_sandbox_runner_rejections_total counter",
  ];
  for (const [reason, count] of [...input.metrics.rejected].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`atypica_sandbox_runner_rejections_total{reason="${reason}"} ${count}`);
  }
  lines.push(
    "# HELP atypica_sandbox_runner_execution_errors_total Failed executions by language and bounded error code.",
    "# TYPE atypica_sandbox_runner_execution_errors_total counter",
  );
  for (const [key, count] of [...input.metrics.executionErrors].sort(([left], [right]) => left.localeCompare(right))) {
    const [language, code] = key.split(":");
    lines.push(`atypica_sandbox_runner_execution_errors_total{language="${language}",code="${code}"} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function startSandboxRunner(config: SandboxRunnerConfig): Promise<SandboxRunnerServer> {
  let activeExecutions = 0;
  let draining = false;
  let drainPromise: Promise<DrainOutcome> | null = null;
  let resolveDrain: ((outcome: DrainOutcome) => void) | null = null;
  let drainForced = false;
  let drainTimer: NodeJS.Timeout | null = null;
  let readiness = await probeContainerRuntime(config);
  let readinessPromise: Promise<ContainerRuntimeReadiness> | null = null;
  const executionControllers = new Set<AbortController>();
  const metrics: RunnerMetrics = {
    accepted: 0,
    completed: 0,
    failed: 0,
    durationSecondsSum: 0,
    durationCount: 0,
    readinessProbeFailures: readiness.ready ? 0 : 1,
    rejected: new Map(),
    executionErrors: new Map(),
  };

  const refreshReadiness = () => {
    if (readinessPromise) return readinessPromise;
    readinessPromise = probeContainerRuntime(config).then((next) => {
      const changed = next.ready !== readiness.ready;
      readiness = next;
      if (!next.ready) metrics.readinessProbeFailures += 1;
      if (changed) {
        console.log(JSON.stringify({
          event: "sandbox_runner_readiness_changed",
          ready: next.ready,
          runtimeAvailable: next.runtimeAvailable,
          imagesAvailable: next.imagesAvailable,
        }));
      }
      return next;
    }).finally(() => {
      readinessPromise = null;
    });
    return readinessPromise;
  };

  const maybeFinishDrain = (server: SandboxRunnerServer) => {
    if (!draining || activeExecutions !== 0 || !resolveDrain) return;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    server.close(() => {
      const outcome = drainForced ? "forced" : "drained";
      console.log(JSON.stringify({ event: "sandbox_runner_stopped", outcome }));
      resolveDrain?.(outcome);
      resolveDrain = null;
    });
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://sandbox-runner.invalid");
    if (request.method === "GET" && url.pathname === "/live") {
      writeJson(response, 200, { protocol: SANDBOX_PROTOCOL, status: "live" });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/ready" || url.pathname === "/health")) {
      const ready = readiness.ready && !draining;
      writeJson(response, ready ? 200 : 503, readinessBody({ readiness, draining, activeExecutions, config }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      if (!metricsAuthenticated(request, config.metricsAuthToken)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      writeMetrics(response, renderMetrics({
        metrics,
        activeExecutions,
        ready: readiness.ready && !draining,
        draining,
      }));
      return;
    }
    if (request.method === "OPTIONS" && url.pathname === "/execute") {
      response.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end();
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/execute") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (!authenticated(request, config.authToken)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (draining) {
      increment(metrics.rejected, "draining");
      writeJson(response, 503, { error: "runner_draining" });
      return;
    }
    if (!readiness.ready) {
      increment(metrics.rejected, "unavailable");
      writeJson(response, 503, { error: "runner_unavailable" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readRequestBody(request, config.maxRequestBytes)) as unknown;
    } catch (error) {
      writeJson(response, error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400, { error: "invalid_json" });
      return;
    }
    const parsed = sandboxExecutionRequestSchema.safeParse(body);
    if (!parsed.success) {
      writeJson(response, 400, { error: "invalid_request", issues: parsed.error.issues.slice(0, 8) });
      return;
    }
    if (draining) {
      increment(metrics.rejected, "draining");
      writeJson(response, 503, { error: "runner_draining" });
      return;
    }
    if (!readiness.ready) {
      increment(metrics.rejected, "unavailable");
      writeJson(response, 503, { error: "runner_unavailable" });
      return;
    }
    if (activeExecutions >= config.maxConcurrency) {
      increment(metrics.rejected, "busy");
      writeJson(response, 429, { error: "runner_busy" });
      return;
    }
    const controller = new AbortController();
    executionControllers.add(controller);
    activeExecutions += 1;
    metrics.accepted += 1;
    try {
      const result = await executeInContainer(parsed.data, config, controller.signal);
      metrics.durationSecondsSum += result.metrics.durationMs / 1_000;
      metrics.durationCount += 1;
      if (result.status === "completed") metrics.completed += 1;
      else {
        metrics.failed += 1;
        increment(metrics.executionErrors, `${parsed.data.runtime.language}:${safeErrorCode(result.errorCode)}`);
      }
      console.log(JSON.stringify({
        event: "sandbox_execution",
        executionId: result.executionId,
        language: parsed.data.runtime.language,
        networkAccess: parsed.data.limits.networkAccess,
        status: result.status,
        errorCode: result.errorCode ?? null,
        durationMs: result.metrics.durationMs,
      }));
      writeJson(response, 200, result);
    } catch {
      metrics.failed += 1;
      increment(metrics.executionErrors, `${parsed.data.runtime.language}:SANDBOX_RUNNER_ERROR`);
      console.error(JSON.stringify({ event: "sandbox_execution_unhandled_error", language: parsed.data.runtime.language }));
      writeJson(response, 500, { error: "runner_error" });
    } finally {
      executionControllers.delete(controller);
      activeExecutions -= 1;
      maybeFinishDrain(server);
    }
  }) as SandboxRunnerServer;

  server.refreshReadiness = refreshReadiness;
  server.beginDrain = () => {
    if (drainPromise) return drainPromise;
    draining = true;
    console.log(JSON.stringify({
      event: "sandbox_runner_draining",
      activeExecutions,
      graceMs: config.shutdownGraceMs,
    }));
    drainPromise = new Promise<DrainOutcome>((resolve) => {
      resolveDrain = resolve;
      drainTimer = setTimeout(() => {
        drainForced = true;
        console.warn(JSON.stringify({ event: "sandbox_runner_drain_deadline", activeExecutions }));
        for (const controller of executionControllers) controller.abort();
        maybeFinishDrain(server);
      }, config.shutdownGraceMs);
      maybeFinishDrain(server);
    });
    return drainPromise;
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const readinessTimer = setInterval(() => {
    if (!draining) void refreshReadiness();
  }, config.readinessProbeIntervalMs);
  readinessTimer.unref();
  server.once("close", () => clearInterval(readinessTimer));
  return server;
}

async function main() {
  const config = loadSandboxRunnerConfig();
  const server = await startSandboxRunner(config);
  const address = server.address();
  console.log(JSON.stringify({ event: "sandbox_runner_ready", address }));
  const close = () => {
    void server.beginDrain().then((outcome) => {
      if (outcome === "forced") process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
