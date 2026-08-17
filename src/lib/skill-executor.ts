import { createHash } from "node:crypto";
import Ajv from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const headerEnvSchema = z.record(
  z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9-]+$/),
  z.string().trim().regex(/^SKILL_SECRET_[A-Z0-9_]+$/),
).default({});

const executorLimitsSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  maxResponseBytes: z.number().int().min(1_024).max(1_048_576).default(262_144),
  headersFromEnv: headerEnvSchema,
});

const sandboxFilePathSchema = z.string().trim().min(1).max(180)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/)
  .refine(
    (value) => value !== "package.json" && value !== ".atypica" && !value.startsWith(".atypica/"),
    "Sandbox path is reserved by the runner",
  );
const sandboxFilesSchema = z.record(sandboxFilePathSchema, z.string().max(120_000))
  .refine((files) => Object.keys(files).length >= 1 && Object.keys(files).length <= 32, "Sandbox source files must contain 1-32 files")
  .refine(
    (files) => Object.values(files).reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0) <= 256_000,
    "Sandbox source files exceed 256 KB",
  );

export const skillExecutorConfigSchema = z.discriminatedUnion("kind", [
  executorLimitsSchema.extend({
    kind: z.literal("declarative_http"),
    endpoint: z.string().url().max(2_000),
    method: z.literal("POST").default("POST"),
  }),
  executorLimitsSchema.extend({
    kind: z.literal("mcp"),
    endpoint: z.string().url().max(2_000),
    toolName: z.string().trim().min(1).max(160),
  }),
  executorLimitsSchema.extend({
    kind: z.literal("sandbox"),
    endpoint: z.string().url().max(2_000),
    language: z.enum(["javascript", "python"]),
    entrypoint: sandboxFilePathSchema,
    files: sandboxFilesSchema,
    maxMemoryMb: z.number().int().min(32).max(512).default(128),
    networkAccess: z.boolean().default(false),
  }).refine((config) => Object.hasOwn(config.files, config.entrypoint), {
    message: "Sandbox entrypoint must exist in source files",
    path: ["entrypoint"],
  }),
]);

export type SkillExecutorConfig = z.infer<typeof skillExecutorConfigSchema>;
export type ExecutorCapability = "network" | "provider_invoke" | "code_execute";
export type SkillExecutionPolicy = {
  allowedNetworkOrigins?: string[];
  allowedSandboxNetworkOrigins?: string[];
};

export class SkillExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillExecutionError";
    this.code = code;
  }
}

export function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function requiredExecutorCapabilities(config: SkillExecutorConfig): ExecutorCapability[] {
  if (config.kind === "mcp") return ["network", "provider_invoke"];
  if (config.kind === "sandbox") return config.networkAccess ? ["code_execute", "network"] : ["code_execute"];
  return ["network"];
}

function allowedOrigins() {
  const configured = (process.env.SKILL_EXECUTOR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  if (process.env.NODE_ENV !== "production") {
    configured.push("http://localhost", "http://127.0.0.1");
  }
  return new Set(configured);
}

function assertAllowedEndpoint(endpoint: string, policy?: SkillExecutionPolicy) {
  const url = new URL(endpoint);
  if (url.username || url.password) {
    throw new SkillExecutionError("SKILL_EXECUTOR_URL_CREDENTIALS_FORBIDDEN", "Executor URL 不能包含用户名或密码");
  }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new SkillExecutionError("SKILL_EXECUTOR_HTTPS_REQUIRED", "Executor 必须使用 HTTPS");
  }
  const origins = allowedOrigins();
  const exactOrigin = origins.has(url.origin);
  const localOrigin = process.env.NODE_ENV !== "production"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    && (origins.has(`http://${url.hostname}`) || origins.has(url.origin));
  if (!exactOrigin && !localOrigin) {
    throw new SkillExecutionError("SKILL_EXECUTOR_ORIGIN_FORBIDDEN", `Executor origin 未加入白名单：${url.origin}`);
  }
  if (policy?.allowedNetworkOrigins && !policy.allowedNetworkOrigins.includes(url.origin)) {
    throw new SkillExecutionError("SKILL_EXECUTOR_NETWORK_SCOPE_DENIED", `Executor origin 未获当前 Skill 版本授权：${url.origin}`);
  }
  return url;
}

function resolveHeaders(headersFromEnv: Record<string, string>) {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, envName] of Object.entries(headersFromEnv)) {
    if (["host", "cookie", "content-length", "transfer-encoding"].includes(name.toLowerCase())) {
      throw new SkillExecutionError("SKILL_EXECUTOR_HEADER_FORBIDDEN", `禁止设置请求头：${name}`);
    }
    const value = process.env[envName];
    if (!value) throw new SkillExecutionError("SKILL_EXECUTOR_SECRET_MISSING", `缺少 Executor 密钥环境变量：${envName}`);
    headers.set(name, value);
  }
  return headers;
}

function validateSchema(schema: Record<string, unknown>, value: unknown, label: "input" | "output") {
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new SkillExecutionError(
      "SKILL_SCHEMA_INVALID",
      `${label} schema 无效：${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  if (!validate(value)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " }).slice(0, 800);
    throw new SkillExecutionError(`SKILL_${label.toUpperCase()}_INVALID`, `${label} 不符合 Skill schema：${detail}`);
  }
}

async function readJsonResponse(response: Response, maxBytes: number) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new SkillExecutionError("SKILL_RESPONSE_TOO_LARGE", "Executor 响应超过大小限制");
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SkillExecutionError("SKILL_RESPONSE_TOO_LARGE", "Executor 响应超过大小限制");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return text ? JSON.parse(text) as unknown : {};
  } catch {
    throw new SkillExecutionError("SKILL_RESPONSE_INVALID_JSON", "Executor 必须返回 JSON");
  }
}

function asJsonContainer(value: unknown): Record<string, unknown> | unknown[] {
  if (value !== null && typeof value === "object") return value as Record<string, unknown> | unknown[];
  return { value };
}

async function executeDeclarativeHttp(
  config: Extract<SkillExecutorConfig, { kind: "declarative_http" }>,
  input: Record<string, unknown>,
  signal: AbortSignal,
  policy?: SkillExecutionPolicy,
) {
  const endpoint = assertAllowedEndpoint(config.endpoint, policy);
  const headers = resolveHeaders(config.headersFromEnv);
  headers.set("content-type", "application/json");
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    redirect: "error",
    credentials: "omit",
    signal,
  });
  if (!response.ok) {
    throw new SkillExecutionError("SKILL_EXECUTOR_HTTP_ERROR", `Executor 返回 HTTP ${response.status}`);
  }
  return asJsonContainer(await readJsonResponse(response, config.maxResponseBytes));
}

async function executeSandbox(
  config: Extract<SkillExecutorConfig, { kind: "sandbox" }>,
  input: Record<string, unknown>,
  signal: AbortSignal,
  policy?: SkillExecutionPolicy,
) {
  if (config.networkAccess) {
    if (!policy?.allowedSandboxNetworkOrigins?.length) {
      throw new SkillExecutionError(
        "SKILL_EXECUTOR_NETWORK_SCOPE_DENIED",
        "Sandbox 网络执行未获得明确的 origin 授权",
      );
    }
    throw new SkillExecutionError(
      "SANDBOX_NETWORK_SCOPE_UNENFORCEABLE",
      "当前 Sandbox Runner 无法对不受信任代码强制执行逐 origin 出站策略",
    );
  }
  const endpoint = assertAllowedEndpoint(config.endpoint, policy);
  const headers = resolveHeaders(config.headersFromEnv);
  headers.set("content-type", "application/json");
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      protocol: "atypica.sandbox/v1",
      runtime: { language: config.language, entrypoint: config.entrypoint },
      files: config.files,
      input,
      limits: {
        timeoutMs: config.timeoutMs,
        maxMemoryMb: config.maxMemoryMb,
        maxOutputBytes: config.maxResponseBytes,
        networkAccess: config.networkAccess,
      },
    }),
    redirect: "error",
    credentials: "omit",
    signal,
  });
  if (!response.ok) {
    throw new SkillExecutionError("SANDBOX_RUNNER_HTTP_ERROR", `Sandbox runner returned HTTP ${response.status}`);
  }
  const payload = await readJsonResponse(response, config.maxResponseBytes);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SkillExecutionError("SANDBOX_RUNNER_INVALID_RESPONSE", "Sandbox runner response must be an object");
  }
  const result = payload as Record<string, unknown>;
  if (result.protocol !== "atypica.sandbox/v1") {
    throw new SkillExecutionError("SANDBOX_RUNNER_PROTOCOL_MISMATCH", "Sandbox runner protocol mismatch");
  }
  if (result.status !== "completed") {
    const errorCode = typeof result.errorCode === "string" ? result.errorCode : "SANDBOX_EXECUTION_FAILED";
    const message = typeof result.errorMessage === "string" ? result.errorMessage.slice(0, 800) : "Sandbox execution failed";
    throw new SkillExecutionError(errorCode, message);
  }
  return asJsonContainer(result.output ?? {});
}

async function executeMcp(
  config: Extract<SkillExecutorConfig, { kind: "mcp" }>,
  input: Record<string, unknown>,
  signal: AbortSignal,
  policy?: SkillExecutionPolicy,
) {
  const endpoint = assertAllowedEndpoint(config.endpoint, policy);
  const headers = resolveHeaders(config.headersFromEnv);
  const controlledFetch: typeof fetch = async (request, init) => {
    const requestUrl = request instanceof Request ? request.url : request.toString();
    assertAllowedEndpoint(requestUrl, policy);
    return fetch(request, { ...init, redirect: "error", credentials: "omit" });
  };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers },
    fetch: controlledFetch,
  });
  const client = new Client({ name: "atypica-skill-gateway", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: config.toolName, arguments: input },
      undefined,
      { signal, timeout: config.timeoutMs },
    );
    if (result.isError) throw new SkillExecutionError("SKILL_MCP_TOOL_ERROR", `MCP tool ${config.toolName} 执行失败`);
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return asJsonContainer(result.structuredContent);
    }
    const content = Array.isArray(result.content)
      ? result.content as Array<{ type: string; text?: string; [key: string]: unknown }>
      : [];
    const text = content
      .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
    if (text) {
      try {
        return asJsonContainer(JSON.parse(text));
      } catch {
        return { content };
      }
    }
    return { content };
  } finally {
    await transport.close().catch(() => undefined);
  }
}

export async function executeConfiguredSkill(input: {
  config: SkillExecutorConfig;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
  policy?: SkillExecutionPolicy;
}) {
  validateSchema(input.inputSchema, input.arguments, "input");
  // The isolated runner still enforces timeoutMs exactly; the caller needs a
  // small window for container teardown and the audited HTTP response.
  const requestTimeoutMs = input.config.kind === "sandbox" ? input.config.timeoutMs + 10_000 : input.config.timeoutMs;
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  let output: Record<string, unknown> | unknown[];
  try {
    output = input.config.kind === "mcp"
      ? await executeMcp(input.config, input.arguments, signal, input.policy)
      : input.config.kind === "sandbox"
        ? await executeSandbox(input.config, input.arguments, signal, input.policy)
        : await executeDeclarativeHttp(input.config, input.arguments, signal, input.policy);
  } catch (error) {
    if (signal.aborted && !(error instanceof SkillExecutionError)) {
      throw new SkillExecutionError("SKILL_EXECUTOR_TIMEOUT", "Skill Executor 超时或被取消");
    }
    throw error;
  }
  validateSchema(input.outputSchema, output, "output");
  return output;
}

export async function probeConfiguredSkill(config: SkillExecutorConfig, policy?: SkillExecutionPolicy) {
  const startedAt = performance.now();
  if (config.kind === "declarative_http" || config.kind === "sandbox") {
    const endpoint = assertAllowedEndpoint(config.endpoint, policy);
    const headers = resolveHeaders(config.headersFromEnv);
    const signal = AbortSignal.timeout(config.timeoutMs);
    const response = await fetch(endpoint, {
      method: "OPTIONS",
      headers,
      redirect: "error",
      credentials: "omit",
      signal,
    });
    // A server that does not implement OPTIONS can still be a reachable JSON executor.
    if (!response.ok && response.status !== 405) {
      throw new SkillExecutionError("SKILL_HEALTH_HTTP_ERROR", `Executor health probe returned HTTP ${response.status}`);
    }
    return {
      latencyMs: Math.round(performance.now() - startedAt),
      detail: config.kind === "sandbox" ? `Sandbox runner HTTP ${response.status}` : `HTTP ${response.status}`,
    };
  }

  const endpoint = assertAllowedEndpoint(config.endpoint, policy);
  const headers = resolveHeaders(config.headersFromEnv);
  const signal = AbortSignal.timeout(config.timeoutMs);
  const controlledFetch: typeof fetch = async (request, init) => {
    const requestUrl = request instanceof Request ? request.url : request.toString();
    assertAllowedEndpoint(requestUrl, policy);
    return fetch(request, { ...init, redirect: "error", credentials: "omit", signal });
  };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers },
    fetch: controlledFetch,
  });
  const client = new Client({ name: "atypica-skill-gateway-health", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools(undefined, { signal, timeout: config.timeoutMs });
    if (!tools.tools.some((tool) => tool.name === config.toolName)) {
      throw new SkillExecutionError("SKILL_HEALTH_MCP_TOOL_MISSING", `MCP endpoint did not expose ${config.toolName}`);
    }
    return { latencyMs: Math.round(performance.now() - startedAt), detail: `MCP ${config.toolName}` };
  } finally {
    await transport.close().catch(() => undefined);
  }
}
