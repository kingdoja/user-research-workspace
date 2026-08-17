import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { executeInContainer } from "./container-runtime";
import { loadSandboxRunnerConfig, type SandboxRunnerConfig } from "./config";
import { SANDBOX_PROTOCOL, sandboxExecutionRequestSchema } from "./protocol";

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

function authenticated(request: IncomingMessage, expectedToken: string) {
  const provided = request.headers["x-sandbox-token"];
  if (typeof provided !== "string") return false;
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
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
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limit) {
        request.removeAllListeners("data");
        request.resume();
        reject(new Error("REQUEST_TOO_LARGE"));
      } else {
        chunks.push(chunk);
      }
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

export async function startSandboxRunner(config: SandboxRunnerConfig) {
  let activeExecutions = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://sandbox-runner.invalid");
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, {
        protocol: SANDBOX_PROTOCOL,
        status: "ready",
        activeExecutions,
        maxConcurrency: config.maxConcurrency,
        runtimes: ["javascript", "python"],
        imageDigestsPinned: {
          javascript: config.javascriptImage.includes("@sha256:"),
          python: config.pythonImage.includes("@sha256:"),
        },
      });
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
    if (activeExecutions >= config.maxConcurrency) {
      writeJson(response, 429, { error: "runner_busy" });
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
    activeExecutions += 1;
    try {
      const result = await executeInContainer(parsed.data, config);
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
    } finally {
      activeExecutions -= 1;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  return server;
}

async function main() {
  const config = loadSandboxRunnerConfig();
  const server = await startSandboxRunner(config);
  const address = server.address();
  console.log(JSON.stringify({ event: "sandbox_runner_ready", address }));
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
