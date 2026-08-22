import { createHash } from "node:crypto";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import {
  describeOpenAIError,
  generateProviderUniversalAgentTurn,
  getProviderStageStatus,
  type ProviderUniversalAgentTurn,
  withProviderRoute,
} from "@/lib/openai-provider";
import { finishProviderRouteDecision, resolveProviderRoute } from "@/lib/platform-control";
import {
  executeConfiguredSkill,
  hashJson,
  requiredExecutorCapabilities,
  SkillExecutionError,
  skillExecutorConfigSchema,
  type SkillExecutionPolicy,
} from "@/lib/skill-executor";
import type { CapabilityGrant, SkillCapability } from "@/lib/skill-gateway";
import {
  executeUniversalAgentProductTool,
  formatUniversalAgentProductToolCatalog,
  isUniversalAgentProductToolName,
  UNIVERSAL_AGENT_PRODUCT_TOOLS,
  type UniversalAgentProductToolName,
} from "@/lib/universal-agent-product-tools";

export const createAgentThreadInputSchema = z.object({
  title: z.string().trim().min(2).max(160),
}).strict();

export const sendAgentMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(12_000),
  skillPublicIds: z.array(z.string().trim().min(1).max(160)).max(12).default([]),
  externalExecutionAllowed: z.boolean().default(false),
  requestId: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9:_-]+$/).optional(),
}).strict();

export const retryAgentRunInputSchema = z.object({
  externalExecutionAllowed: z.boolean().default(false),
  requestId: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9:_-]+$/),
}).strict();

export type UniversalAgentWorkspace = {
  provider: ReturnType<typeof getProviderStageStatus>;
  threads: Array<{
    publicId: string;
    title: string;
    status: "active" | "archived";
    updatedAt: string;
    lastMessage: string | null;
    lastRunStatus: "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled" | null;
  }>;
  selectedThreadPublicId: string | null;
  messages: Array<{
    publicId: string;
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
  files: Array<{ publicId: string; path: string; mediaType: string; version: number; byteSize: number; updatedAt: string }>;
  skills: Array<{
    publicId: string;
    slug: string;
    name: string;
    description: string;
    version: number;
    executorType: "declarative_http" | "mcp" | "sandbox";
    packageFormat: "inline" | "atypica.skill/v1" | "atypica.skill/v2";
  }>;
  productTools: Array<{
    name: UniversalAgentProductToolName;
    title: string;
    description: string;
    mutates: boolean;
  }>;
  recentRuns: Array<{
    publicId: string;
    threadPublicId: string;
    status: "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";
    stepsUsed: number;
    maxSteps: number;
    toolCallsUsed: number;
    maxToolCalls: number;
    productToolCallsUsed: number;
    maxProductToolCalls: number;
    externalToolCallsUsed: number;
    maxExternalToolCalls: number;
    tokensUsed: number;
    tokenBudget: number;
    costMicrosUsed: number;
    maxCostMicros: number;
    externalExecutionAllowed: boolean;
    retryOfRunPublicId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string;
  }>;
};

type AgentDecision = Omit<ProviderUniversalAgentTurn, "responseId" | "model" | "promptVersion" | "usage" | "productToolName"> & {
  responseId?: string;
  model?: string;
  promptVersion?: string;
  usage?: unknown;
  productToolName?: string | null;
};

type AgentDecisionProvider = (input: Parameters<typeof generateProviderUniversalAgentTurn>[0]) => Promise<AgentDecision>;

type BoundAgentSkill = {
  skill_id: string;
  version_id: string;
  public_id: string;
  slug: string;
  name: string;
  version: number;
  executor_type: "declarative_http" | "mcp" | "sandbox";
  executor_config: Record<string, unknown> | string;
  input_schema: Record<string, unknown> | string;
  output_schema: Record<string, unknown> | string;
  package_content: Record<string, unknown> | string;
  requested_capabilities: SkillCapability[] | string;
  content_hash: string;
  bindingId: string;
  bindingPublicId: string;
  grants: CapabilityGrant[];
};

const AGENT_RUN_LEASE_MS = 5 * 60_000;
const AGENT_RUN_HEARTBEAT_MS = 60_000;

class AgentRunBlockedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly sequence: number,
  ) {
    super(message);
    this.name = "AgentRunBlockedError";
  }
}

function jsonValue<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function contentChecksum(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeWorkspacePath(pathInput: string) {
  const path = pathInput.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.length > 240 || path.startsWith("/") || path.startsWith("skills/") || /(^|\/)\.\.($|\/)/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("AGENT_WORKSPACE_PATH_INVALID");
  }
  return path;
}

function parseArguments(value: string | null) {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AGENT_SKILL_ARGUMENTS_INVALID");
  return parsed as Record<string, unknown>;
}

function executionPolicy(config: z.infer<typeof skillExecutorConfigSchema>, grants: CapabilityGrant[]): SkillExecutionPolicy {
  const networkGrant = grants.find((grant) => grant.capability === "network");
  if (!networkGrant) return {};
  const origins = networkGrant.scope.origins;
  if (config.kind === "sandbox") {
    return {
      allowedSandboxNetworkOrigins: Array.isArray(origins)
        && origins.every((origin) => typeof origin === "string")
        ? origins.map((origin) => new URL(origin).origin)
        : [],
    };
  }
  if (Array.isArray(origins) && origins.every((origin) => typeof origin === "string")) {
    return { allowedNetworkOrigins: origins.map((origin) => new URL(origin).origin) };
  }
  return { allowedNetworkOrigins: [new URL(config.endpoint).origin] };
}

function tokenUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return { input_tokens: 0, output_tokens: 0 };
  const value = usage as Record<string, unknown>;
  const normalize = (candidate: unknown) => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  };
  return {
    input_tokens: normalize(value.input_tokens ?? value.prompt_tokens),
    output_tokens: normalize(value.output_tokens ?? value.completion_tokens),
  };
}

function providerCostMicros(inputTokens: number, outputTokens: number, route: {
  inputPriceMicrosPerMillion: number;
  outputPriceMicrosPerMillion: number;
} | null) {
  if (!route) return 0;
  return Math.max(0, Math.round((
    route.inputPriceMicrosPerMillion * inputTokens
    + route.outputPriceMicrosPerMillion * outputTokens
  ) / 1_000_000));
}

export async function listUniversalAgentWorkspace(
  viewer: Viewer,
  requestedThreadPublicId?: string | null,
): Promise<UniversalAgentWorkspace> {
  const database = await getDatabase();
  const [threadsResult, filesResult, skillsResult, runsResult] = await Promise.all([
    database.query<{
      public_id: string; title: string; status: "active" | "archived"; updated_at: string;
      last_message: string | null; last_run_status: UniversalAgentWorkspace["threads"][number]["lastRunStatus"];
    }>(
      `select thread.public_id, thread.title, thread.status, thread.updated_at::text as updated_at,
              message.content as last_message, run.status as last_run_status
       from agent_threads thread
       left join lateral (select content from agent_messages where thread_id = thread.id order by created_at desc, id desc limit 1) message on true
       left join lateral (select status from agent_runs where thread_id = thread.id order by started_at desc, id desc limit 1) run on true
       where thread.workspace_id = $1 order by thread.updated_at desc, thread.id desc limit 40`,
      [viewer.workspaceId],
    ),
    database.query<{ public_id: string; path: string; media_type: string; version: number; byte_size: number; updated_at: string }>(
      `select public_id, path, media_type, version, byte_size, updated_at::text as updated_at
       from agent_workspace_files where workspace_id = $1 order by path limit 200`,
      [viewer.workspaceId],
    ),
    database.query<{
      public_id: string; slug: string; name: string; description: string; version: number;
      executor_type: UniversalAgentWorkspace["skills"][number]["executorType"];
      package_format: UniversalAgentWorkspace["skills"][number]["packageFormat"];
    }>(
      `select skill.public_id, skill.slug, skill.name, skill.description, version.version,
              version.executor_type, version.package_format
       from skill_manifests skill
       join workspace_skill_settings setting on setting.workspace_id = skill.workspace_id
         and setting.skill_id = skill.id and setting.skill_source = 'workspace' and setting.enabled
       join skill_versions version on version.skill_id = skill.id
         and version.version = coalesce(setting.pinned_version, skill.latest_version)
       where skill.workspace_id = $1 and skill.status = 'active'
         and (skill.visibility = 'workspace' or skill.owner_user_id = $2)
         and version.executor_type in ('declarative_http', 'mcp', 'sandbox')
         and not exists (
           select 1 from jsonb_array_elements_text(version.requested_capabilities) requested(capability)
           where not exists (
             select 1 from workspace_skill_capability_grants capability_grant
             where capability_grant.workspace_id = skill.workspace_id and capability_grant.skill_version_id = version.id
               and capability_grant.capability = requested.capability
           )
         )
       order by skill.name, skill.id`,
      [viewer.workspaceId, viewer.userId],
    ),
    database.query<{
      public_id: string; thread_public_id: string; status: UniversalAgentWorkspace["recentRuns"][number]["status"];
      steps_used: number; max_steps: number; tool_calls_used: number; max_tool_calls: number;
      product_tool_calls_used: number; max_product_tool_calls: number;
      external_tool_calls_used: number; max_external_tool_calls: number;
      input_tokens_used: string; output_tokens_used: string; token_budget: string;
      cost_micros_used: string; max_cost_micros: string;
      retry_of_run_public_id: string | null; error_code: string | null; error_message: string | null;
      external_execution_allowed: boolean; started_at: string;
    }>(
      `select run.public_id, thread.public_id as thread_public_id, run.status, run.steps_used,
              run.max_steps, run.tool_calls_used, run.max_tool_calls,
              run.product_tool_calls_used, run.max_product_tool_calls,
              run.external_tool_calls_used, run.max_external_tool_calls,
              run.input_tokens_used::text as input_tokens_used, run.output_tokens_used::text as output_tokens_used,
              run.token_budget::text as token_budget, run.cost_micros_used::text as cost_micros_used,
              run.max_cost_micros::text as max_cost_micros,
              retry_source.public_id as retry_of_run_public_id, run.error_code, run.error_message,
              run.external_execution_allowed, run.started_at::text as started_at
       from agent_runs run join agent_threads thread on thread.id = run.thread_id
       left join agent_runs retry_source on retry_source.id = run.retry_of_run_id
       where run.workspace_id = $1 order by run.started_at desc, run.id desc limit 30`,
      [viewer.workspaceId],
    ),
  ]);
  const selected = threadsResult.rows.find((thread) => thread.public_id === requestedThreadPublicId)
    ?? threadsResult.rows[0]
    ?? null;
  const messagesResult = selected
    ? await database.query<{
        public_id: string; role: UniversalAgentWorkspace["messages"][number]["role"];
        content: string; metadata: Record<string, unknown> | string; created_at: string;
      }>(
        `select message.public_id, message.role, message.content, message.metadata, message.created_at::text as created_at
         from agent_messages message join agent_threads thread on thread.id = message.thread_id
         where thread.public_id = $1 and thread.workspace_id = $2 order by message.created_at, message.id limit 300`,
        [selected.public_id, viewer.workspaceId],
      )
    : { rows: [] };
  return {
    provider: getProviderStageStatus("reasoning"),
    threads: threadsResult.rows.map((row) => ({
      publicId: row.public_id, title: row.title, status: row.status, updatedAt: row.updated_at,
      lastMessage: row.last_message, lastRunStatus: row.last_run_status,
    })),
    selectedThreadPublicId: selected?.public_id ?? null,
    messages: messagesResult.rows.map((row) => ({
      publicId: row.public_id, role: row.role, content: row.content,
      metadata: jsonValue(row.metadata), createdAt: row.created_at,
    })),
    files: filesResult.rows.map((row) => ({
      publicId: row.public_id, path: row.path, mediaType: row.media_type,
      version: row.version, byteSize: row.byte_size, updatedAt: row.updated_at,
    })),
    skills: skillsResult.rows.map((row) => ({
      publicId: row.public_id, slug: row.slug, name: row.name, description: row.description,
      version: row.version, executorType: row.executor_type, packageFormat: row.package_format,
    })),
    productTools: UNIVERSAL_AGENT_PRODUCT_TOOLS.map(({ name, title, description, mutates }) => ({ name, title, description, mutates })),
    recentRuns: runsResult.rows.map((row) => ({
      publicId: row.public_id, threadPublicId: row.thread_public_id, status: row.status,
      stepsUsed: row.steps_used, maxSteps: row.max_steps,
      toolCallsUsed: row.tool_calls_used, maxToolCalls: row.max_tool_calls,
      productToolCallsUsed: row.product_tool_calls_used, maxProductToolCalls: row.max_product_tool_calls,
      externalToolCallsUsed: row.external_tool_calls_used, maxExternalToolCalls: row.max_external_tool_calls,
      tokensUsed: Number(row.input_tokens_used) + Number(row.output_tokens_used), tokenBudget: Number(row.token_budget),
      costMicrosUsed: Number(row.cost_micros_used), maxCostMicros: Number(row.max_cost_micros),
      retryOfRunPublicId: row.retry_of_run_public_id, errorCode: row.error_code, errorMessage: row.error_message,
      externalExecutionAllowed: row.external_execution_allowed, startedAt: row.started_at,
    })),
  };
}

export async function createAgentThread(viewer: Viewer, input: z.infer<typeof createAgentThreadInputSchema>) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{ public_id: string }>(
    `insert into agent_threads (public_id, workspace_id, created_by, title)
     values ($1, $2, $3, $4) returning public_id`,
    [createPublicId("agt"), viewer.workspaceId, viewer.userId, input.title],
  );
  return { publicId: result.rows[0].public_id };
}

export async function getAgentWorkspaceFile(viewer: Viewer, publicId: string) {
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string; path: string; content: string; media_type: string; version: number; byte_size: number; checksum: string;
  }>(
    `select public_id, path, content, media_type, version, byte_size, checksum
     from agent_workspace_files where public_id = $1 and workspace_id = $2 limit 1`,
    [publicId, viewer.workspaceId],
  );
  const file = result.rows[0];
  return file ? {
    publicId: file.public_id, path: file.path, content: file.content, mediaType: file.media_type,
    version: file.version, byteSize: file.byte_size, checksum: file.checksum,
  } : "not_found" as const;
}

async function bindAgentSkills(
  queryable: Queryable,
  viewer: Viewer,
  runId: string,
  publicIds: string[],
): Promise<BoundAgentSkill[]> {
  if (!publicIds.length) return [];
  const uniqueIds = [...new Set(publicIds)];
  const result = await queryable.query<{
    skill_id: string; version_id: string; public_id: string; slug: string; name: string; version: number;
    executor_type: "declarative_http" | "mcp" | "sandbox"; executor_config: Record<string, unknown> | string;
    input_schema: Record<string, unknown> | string; output_schema: Record<string, unknown> | string;
    package_content: Record<string, unknown> | string; requested_capabilities: SkillCapability[] | string;
    content_hash: string;
  }>(
    `select skill.id::text as skill_id, version.id::text as version_id, skill.public_id, skill.slug, skill.name,
            version.version, version.executor_type, version.executor_config, version.input_schema,
            version.output_schema, version.package_content, version.requested_capabilities, version.content_hash
     from skill_manifests skill
     join workspace_skill_settings setting on setting.workspace_id = skill.workspace_id and setting.skill_id = skill.id
       and setting.skill_source = 'workspace' and setting.enabled
     join skill_versions version on version.skill_id = skill.id
       and version.version = coalesce(setting.pinned_version, skill.latest_version)
     where skill.workspace_id = $1 and skill.status = 'active' and skill.public_id = any($2::text[])
       and (skill.visibility = 'workspace' or skill.owner_user_id = $3)
       and version.executor_type in ('declarative_http', 'mcp', 'sandbox')`,
    [viewer.workspaceId, uniqueIds, viewer.userId],
  );
  if (result.rows.length !== uniqueIds.length) throw new Error("AGENT_SKILL_NOT_AVAILABLE");
  const bindings: BoundAgentSkill[] = [];
  for (const skill of result.rows) {
    const grantsResult = await queryable.query<{ capability: SkillCapability; scope: Record<string, unknown> | string }>(
      `select capability, scope from workspace_skill_capability_grants
       where workspace_id = $1 and skill_version_id = $2 order by capability`,
      [viewer.workspaceId, skill.version_id],
    );
    const grants = grantsResult.rows.map((grant) => ({ capability: grant.capability, scope: jsonValue(grant.scope) }));
    const requested = jsonValue<SkillCapability[]>(skill.requested_capabilities);
    if (requested.some((capability) => !grants.some((grant) => grant.capability === capability))) {
      throw new Error("AGENT_SKILL_CAPABILITY_DENIED");
    }
    const inserted = await queryable.query<{ id: string; public_id: string }>(
      `insert into agent_run_skill_bindings (
         public_id, run_id, workspace_id, skill_id, skill_version_id, skill_public_id, skill_slug,
         skill_name, skill_version, executor_type, executor_config, input_schema, output_schema,
         package_content, capability_grants, content_hash
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
                 $13::jsonb, $14::jsonb, $15::jsonb, $16)
       returning id::text as id, public_id`,
      [
        createPublicId("asb"), runId, viewer.workspaceId, skill.skill_id, skill.version_id,
        skill.public_id, skill.slug, skill.name, skill.version, skill.executor_type,
        JSON.stringify(jsonValue(skill.executor_config)), JSON.stringify(jsonValue(skill.input_schema)),
        JSON.stringify(jsonValue(skill.output_schema)), JSON.stringify(jsonValue(skill.package_content)),
        JSON.stringify(grants), skill.content_hash,
      ],
    );
    bindings.push({ ...skill, bindingId: inserted.rows[0].id, bindingPublicId: inserted.rows[0].public_id, grants });
  }
  return bindings;
}

async function executeBoundSkill(input: {
  queryable: Queryable;
  viewer: Viewer;
  runId: string;
  stepId: string;
  binding: BoundAgentSkill;
  arguments: Record<string, unknown>;
}) {
  const configResult = skillExecutorConfigSchema.safeParse(jsonValue(input.binding.executor_config));
  if (!configResult.success || configResult.data.kind !== input.binding.executor_type) throw new Error("AGENT_SKILL_CONFIG_INVALID");
  const config = configResult.data;
  const required = requiredExecutorCapabilities(config);
  if (required.some((capability) => !input.binding.grants.some((grant) => grant.capability === capability))) {
    throw new Error("AGENT_SKILL_CAPABILITY_DENIED");
  }
  const skillExecution = await input.queryable.query<{ id: string; public_id: string }>(
    `insert into skill_executions (
       public_id, workspace_id, skill_id, skill_version_id, actor_user_id, executor_type,
       input, request_hash, agent_run_id, agent_step_id
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     returning id::text as id, public_id`,
    [
      createPublicId("ske"), input.viewer.workspaceId, input.binding.skill_id, input.binding.version_id,
      input.viewer.userId, input.binding.executor_type, JSON.stringify(input.arguments), hashJson(input.arguments),
      input.runId, input.stepId,
    ],
  );
  const sandbox = config.kind === "sandbox"
    ? await input.queryable.query<{ id: string; public_id: string }>(
        `insert into sandbox_executions (
           public_id, workspace_id, agent_run_id, agent_step_id, skill_binding_id, actor_user_id,
           language, entrypoint, network_access, limits, input_hash
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         returning id::text as id, public_id`,
        [
          createPublicId("sbx"), input.viewer.workspaceId, input.runId, input.stepId,
          input.binding.bindingId, input.viewer.userId, config.language, config.entrypoint,
          config.networkAccess,
          JSON.stringify({ timeoutMs: config.timeoutMs, maxMemoryMb: config.maxMemoryMb, maxOutputBytes: config.maxResponseBytes }),
          hashJson(input.arguments),
        ],
      )
    : null;
  try {
    const output = await executeConfiguredSkill({
      config,
      inputSchema: jsonValue(input.binding.input_schema),
      outputSchema: jsonValue(input.binding.output_schema),
      arguments: input.arguments,
      policy: executionPolicy(config, input.binding.grants),
    });
    const responseHash = hashJson(output);
    await input.queryable.query(
      `update skill_executions set status = 'completed', output = $2::jsonb, response_hash = $3, finished_at = now() where id = $1`,
      [skillExecution.rows[0].id, JSON.stringify(output), responseHash],
    );
    if (sandbox) {
      await input.queryable.query(
        `update sandbox_executions set status = 'completed', output = $2::jsonb, output_hash = $3, exit_code = 0, finished_at = now() where id = $1`,
        [sandbox.rows[0].id, JSON.stringify(output), responseHash],
      );
    }
    return { executionPublicId: skillExecution.rows[0].public_id, sandboxPublicId: sandbox?.rows[0].public_id ?? null, output };
  } catch (error) {
    const code = error instanceof SkillExecutionError ? error.code : "SKILL_EXECUTION_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Skill execution failed";
    await input.queryable.query(
      `update skill_executions set status = 'failed', error_code = $2, error_message = $3, finished_at = now() where id = $1`,
      [skillExecution.rows[0].id, code, message],
    );
    if (sandbox) {
      await input.queryable.query(
        `update sandbox_executions set status = 'failed', error_code = $2, error_message = $3, finished_at = now() where id = $1`,
        [sandbox.rows[0].id, code, message],
      );
    }
    throw error;
  }
}

async function executeAgentTool(input: {
  queryable: Queryable;
  viewer: Viewer;
  runId: string;
  stepId: string;
  decision: AgentDecision;
  bindings: BoundAgentSkill[];
  externalExecutionAllowed: boolean;
}) {
  if (input.decision.action === "list_files") {
    const files = await input.queryable.query<{ path: string; byte_size: number; version: number }>(
      "select path, byte_size, version from agent_workspace_files where workspace_id = $1 order by path limit 200",
      [input.viewer.workspaceId],
    );
    return { files: files.rows.map((file) => ({ path: file.path, byteSize: file.byte_size, version: file.version })) };
  }
  if (input.decision.action === "read_file") {
    if (!input.decision.path) throw new Error("AGENT_FILE_PATH_REQUIRED");
    const path = normalizeWorkspacePath(input.decision.path);
    const file = await input.queryable.query<{ content: string; version: number; media_type: string }>(
      "select content, version, media_type from agent_workspace_files where workspace_id = $1 and path = $2",
      [input.viewer.workspaceId, path],
    );
    if (!file.rows[0]) return { error: "file_not_found", path };
    return { path, content: file.rows[0].content, version: file.rows[0].version, mediaType: file.rows[0].media_type };
  }
  if (input.decision.action === "write_file") {
    if (!input.decision.path || input.decision.content === null) throw new Error("AGENT_FILE_CONTENT_REQUIRED");
    const path = normalizeWorkspacePath(input.decision.path);
    const bytes = Buffer.byteLength(input.decision.content, "utf8");
    if (bytes > 262_144) throw new Error("AGENT_FILE_TOO_LARGE");
    const result = await input.queryable.query<{ public_id: string; version: number }>(
      `insert into agent_workspace_files (
         public_id, workspace_id, path, content, media_type, byte_size, checksum, updated_by
       ) values ($1, $2, $3, $4, 'text/plain', $5, $6, $7)
       on conflict (workspace_id, path) do update set
         content = excluded.content, byte_size = excluded.byte_size, checksum = excluded.checksum,
         version = agent_workspace_files.version + 1, updated_by = excluded.updated_by, updated_at = now()
       returning public_id, version`,
      [createPublicId("agf"), input.viewer.workspaceId, path, input.decision.content, bytes, contentChecksum(input.decision.content), input.viewer.userId],
    );
    return { path, version: result.rows[0].version, byteSize: bytes, checksum: contentChecksum(input.decision.content) };
  }
  if (input.decision.action === "execute_skill") {
    if (!input.externalExecutionAllowed) return { error: "external_execution_not_confirmed" };
    const binding = input.bindings.find((item) => item.public_id === input.decision.skillPublicId);
    if (!binding) return { error: "skill_not_bound", skillPublicId: input.decision.skillPublicId };
    return executeBoundSkill({
      queryable: input.queryable, viewer: input.viewer, runId: input.runId, stepId: input.stepId,
      binding, arguments: parseArguments(input.decision.argumentsJson),
    });
  }
  if (input.decision.action === "execute_product_tool") {
    const productToolName = input.decision.productToolName ?? null;
    if (!isUniversalAgentProductToolName(productToolName)) {
      return { error: "product_tool_name_required" };
    }
    return executeUniversalAgentProductTool({
      viewer: input.viewer,
      toolName: productToolName,
      arguments: parseArguments(input.decision.argumentsJson),
      executionAllowed: input.externalExecutionAllowed,
    });
  }
  throw new Error("AGENT_TOOL_ACTION_INVALID");
}

async function expireAgentRunLeases(queryable: Queryable, threadId?: string) {
  const expired = await queryable.query<{ id: string; thread_id: string }>(
    `select id::text as id, thread_id::text as thread_id
     from agent_runs
     where status = 'running' and lease_expires_at <= now()
       and ($1::bigint is null or thread_id = $1)
     order by lease_expires_at, id limit 50
     for update skip locked`,
    [threadId ?? null],
  );
  if (!expired.rows.length) return 0;
  const runIds = expired.rows.map((run) => run.id);
  await queryable.query(
    `update agent_steps set status = 'failed', error_code = 'AGENT_RUN_LEASE_EXPIRED',
       error_message = 'Worker lease expired before the step outcome was committed', finished_at = now()
     where run_id = any($1::bigint[]) and status = 'running'`,
    [runIds],
  );
  await queryable.query(
    `update skill_executions set status = 'failed', error_code = 'AGENT_RUN_LEASE_EXPIRED',
       error_message = 'Agent worker lease expired', finished_at = now()
     where agent_run_id = any($1::bigint[]) and status = 'running'`,
    [runIds],
  );
  await queryable.query(
    `update sandbox_executions set status = 'cancelled', error_code = 'AGENT_RUN_LEASE_EXPIRED',
       error_message = 'Agent worker lease expired', finished_at = now()
     where agent_run_id = any($1::bigint[]) and status = 'running'`,
    [runIds],
  );
  await queryable.query(
    `update provider_route_decisions set status = 'failed', error_code = 'AGENT_RUN_LEASE_EXPIRED',
       latency_ms = least(2147483647, greatest(0, extract(epoch from (now() - created_at)) * 1000))::int,
       finished_at = now()
     where agent_run_id = any($1::bigint[]) and status = 'selected'`,
    [runIds],
  );
  await queryable.query(
    `update agent_runs set status = 'failed', error_code = 'AGENT_RUN_LEASE_EXPIRED',
       error_message = 'Worker lease expired; external effects were not replayed automatically',
       finished_at = now(), lease_owner = null, lease_expires_at = null, heartbeat_at = null
     where id = any($1::bigint[]) and status = 'running'`,
    [runIds],
  );
  for (const run of expired.rows) {
    await queryable.query(
      `insert into agent_messages (public_id, thread_id, role, content, metadata)
       values ($1, $2, 'assistant', $3, $4::jsonb)`,
      [
        createPublicId("agm"), run.thread_id,
        "本轮执行未完成：后台 Worker 租约已过期，系统未自动重放可能产生外部副作用的步骤。",
        JSON.stringify({ errorCode: "AGENT_RUN_LEASE_EXPIRED" }),
      ],
    );
  }
  await queryable.query(
    "update agent_threads set updated_at = now() where id = any($1::bigint[])",
    [[...new Set(expired.rows.map((run) => run.thread_id))]],
  );
  return expired.rows.length;
}

export async function sendAgentMessage(
  viewer: Viewer,
  threadPublicId: string,
  input: z.infer<typeof sendAgentMessageInputSchema>,
  options?: {
    maxSteps?: number;
    maxToolCalls?: number;
    maxProductToolCalls?: number;
    maxExternalToolCalls?: number;
    tokenBudget?: number;
    maxCostMicros?: number;
    retryOfRunId?: string;
    retryOfRunPublicId?: string;
  },
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const maxSteps = Math.min(12, Math.max(1, options?.maxSteps ?? 6));
  const maxToolCalls = Math.min(24, Math.max(0, options?.maxToolCalls ?? maxSteps));
  const maxProductToolCalls = Math.min(24, Math.max(0, options?.maxProductToolCalls ?? Math.min(4, maxToolCalls)));
  const maxExternalToolCalls = Math.min(24, Math.max(0, options?.maxExternalToolCalls ?? Math.min(2, maxToolCalls)));
  const tokenBudget = Math.min(1_000_000, Math.max(1, options?.tokenBudget ?? 100_000));
  const maxCostMicros = Math.min(1_000_000_000, Math.max(1, options?.maxCostMicros ?? 1_000_000));
  const requestId = input.requestId ?? createPublicId("req");
  return database.transaction(async (transaction) => {
    const thread = await transaction.query<{ id: string }>(
      "select id::text as id from agent_threads where public_id = $1 and workspace_id = $2 and status = 'active' for update",
      [threadPublicId, viewer.workspaceId],
    );
    if (!thread.rows[0]) return "not_found" as const;
    await expireAgentRunLeases(transaction, thread.rows[0].id);
    const existing = await transaction.query<{ public_id: string; status: "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled" }>(
      "select public_id, status from agent_runs where thread_id = $1 and idempotency_key = $2 limit 1",
      [thread.rows[0].id, requestId],
    );
    if (existing.rows[0]) {
      return { runPublicId: existing.rows[0].public_id, status: existing.rows[0].status, reused: true };
    }
    const active = await transaction.query<{ public_id: string; status: "queued" | "running" }>(
      "select public_id, status from agent_runs where thread_id = $1 and status in ('queued', 'running') limit 1",
      [thread.rows[0].id],
    );
    if (active.rows[0]) {
      return { error: "busy" as const, runPublicId: active.rows[0].public_id, status: active.rows[0].status };
    }
    const message = await transaction.query<{ id: string }>(
      `insert into agent_messages (public_id, thread_id, actor_user_id, role, content, metadata)
       values ($1, $2, $3, 'user', $4, $5::jsonb) returning id::text as id`,
      [
        createPublicId("agm"), thread.rows[0].id, viewer.userId, input.content,
        JSON.stringify(options?.retryOfRunPublicId ? { retryOfRunPublicId: options.retryOfRunPublicId } : {}),
      ],
    );
    const run = await transaction.query<{ id: string; public_id: string }>(
      `insert into agent_runs (
         public_id, workspace_id, thread_id, initiated_by, user_message_id, objective,
         status, max_steps, max_tool_calls, max_product_tool_calls, max_external_tool_calls,
         token_budget, max_cost_micros, external_execution_allowed, idempotency_key, retry_of_run_id
       ) values ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11, $12, $13, $14, $15)
       returning id::text as id, public_id`,
      [
        createPublicId("agr"), viewer.workspaceId, thread.rows[0].id, viewer.userId,
        message.rows[0].id, input.content, maxSteps, maxToolCalls, maxProductToolCalls,
        maxExternalToolCalls, tokenBudget, maxCostMicros, input.externalExecutionAllowed, requestId,
        options?.retryOfRunId ?? null,
      ],
    );
    await bindAgentSkills(transaction, viewer, run.rows[0].id, input.skillPublicIds);
    await transaction.query("update agent_threads set updated_at = now() where id = $1", [thread.rows[0].id]);
    return { runPublicId: run.rows[0].public_id, status: "queued" as const, reused: false };
  });
}

export async function retryAgentRun(
  viewer: Viewer,
  threadPublicId: string,
  runPublicId: string,
  input: z.infer<typeof retryAgentRunInputSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const sourceResult = await database.query<{
    id: string; objective: string; status: string; external_execution_allowed: boolean;
    max_steps: number; max_tool_calls: number; max_product_tool_calls: number;
    max_external_tool_calls: number; token_budget: string; max_cost_micros: string;
    skill_public_ids: string[] | string;
  }>(
    `select run.id::text as id, run.objective, run.status, run.external_execution_allowed,
            run.max_steps, run.max_tool_calls, run.max_product_tool_calls,
            run.max_external_tool_calls, run.token_budget::text as token_budget,
            run.max_cost_micros::text as max_cost_micros,
            coalesce(jsonb_agg(binding.skill_public_id order by binding.id)
              filter (where binding.id is not null), '[]'::jsonb) as skill_public_ids
     from agent_runs run join agent_threads thread on thread.id = run.thread_id
     left join agent_run_skill_bindings binding on binding.run_id = run.id
     where run.public_id = $1 and thread.public_id = $2 and run.workspace_id = $3
     group by run.id`,
    [runPublicId, threadPublicId, viewer.workspaceId],
  );
  const source = sourceResult.rows[0];
  if (!source) return "not_found" as const;
  if (!["failed", "blocked"].includes(source.status)) return "not_retryable" as const;
  if (source.external_execution_allowed && !input.externalExecutionAllowed) {
    return "execution_confirmation_required" as const;
  }
  const skillPublicIds = jsonValue<string[]>(source.skill_public_ids);
  return sendAgentMessage(viewer, threadPublicId, {
    content: source.objective,
    skillPublicIds,
    externalExecutionAllowed: input.externalExecutionAllowed,
    requestId: input.requestId,
  }, {
    maxSteps: source.max_steps,
    maxToolCalls: source.max_tool_calls,
    maxProductToolCalls: source.max_product_tool_calls,
    maxExternalToolCalls: source.max_external_tool_calls,
    tokenBudget: Number(source.token_budget),
    maxCostMicros: Number(source.max_cost_micros),
    retryOfRunId: source.id,
    retryOfRunPublicId: runPublicId,
  });
}

async function claimAgentRun(queryable: Queryable, workerId: string, requestedRunPublicId?: string) {
  await expireAgentRunLeases(queryable);
  const claimed = await queryable.query<{ id: string; public_id: string }>(
    `update agent_runs set status = 'running', attempt_count = attempt_count + 1,
       lease_owner = $1, heartbeat_at = now(),
       lease_expires_at = now() + ($2::double precision * interval '1 millisecond')
     where id = (
       select id from agent_runs
        where (
          (status = 'queued' and available_at <= now())
          or (status = 'running' and lease_owner = $1 and $3::text is not null)
        )
          and ($3::text is null or public_id = $3)
       order by available_at, started_at, id limit 1 for update skip locked
     )
     returning id::text as id, public_id`,
    [workerId, AGENT_RUN_LEASE_MS, requestedRunPublicId ?? null],
  );
  return claimed.rows[0] ?? null;
}

async function renewAgentRunLease(queryable: Queryable, runId: string, workerId: string) {
  const renewed = await queryable.query<{ id: string }>(
    `update agent_runs set heartbeat_at = now(),
       lease_expires_at = now() + ($3::double precision * interval '1 millisecond')
     where id = $1 and status = 'running' and lease_owner = $2 returning id::text as id`,
    [runId, workerId, AGENT_RUN_LEASE_MS],
  );
  if (!renewed.rows[0]) throw new Error("AGENT_RUN_LEASE_LOST");
}

async function withAgentRunLeaseHeartbeat<T>(input: {
  queryable: Queryable;
  runId: string;
  workerId: string;
  execute: () => Promise<T>;
}) {
  await renewAgentRunLease(input.queryable, input.runId, input.workerId);
  let heartbeatError: unknown = null;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    if (heartbeatError) return;
    heartbeat = heartbeat
      .then(() => renewAgentRunLease(input.queryable, input.runId, input.workerId))
      .catch((error) => {
        heartbeatError ??= error;
      });
  }, AGENT_RUN_HEARTBEAT_MS);
  timer.unref?.();
  try {
    const result = await input.execute();
    await heartbeat;
    if (heartbeatError) throw heartbeatError;
    await renewAgentRunLease(input.queryable, input.runId, input.workerId);
    return result;
  } finally {
    clearInterval(timer);
  }
}

async function loadAgentRunSkillBindings(queryable: Queryable, runId: string): Promise<BoundAgentSkill[]> {
  const result = await queryable.query<{
    binding_id: string; binding_public_id: string; skill_id: string; version_id: string;
    public_id: string; slug: string; name: string; version: number;
    executor_type: BoundAgentSkill["executor_type"];
    executor_config: Record<string, unknown> | string; input_schema: Record<string, unknown> | string;
    output_schema: Record<string, unknown> | string; package_content: Record<string, unknown> | string;
    capability_grants: CapabilityGrant[] | string; content_hash: string;
  }>(
    `select binding.id::text as binding_id, binding.public_id as binding_public_id,
            binding.skill_id::text as skill_id, binding.skill_version_id::text as version_id,
            binding.skill_public_id as public_id, binding.skill_slug as slug, binding.skill_name as name,
            binding.skill_version as version, binding.executor_type, binding.executor_config,
            binding.input_schema, binding.output_schema, binding.package_content,
            binding.capability_grants, binding.content_hash
     from agent_run_skill_bindings binding where binding.run_id = $1 order by binding.id`,
    [runId],
  );
  return result.rows.map((binding) => ({
    ...binding,
    bindingId: binding.binding_id,
    bindingPublicId: binding.binding_public_id,
    requested_capabilities: [],
    grants: jsonValue<CapabilityGrant[]>(binding.capability_grants),
  }));
}

async function failClaimedAgentRun(input: {
  queryable: Queryable;
  runId: string;
  workerId: string;
  threadId: string;
  runPublicId: string;
  route: Awaited<ReturnType<typeof resolveProviderRoute>>;
  routeUsage: { input_tokens: number; output_tokens: number };
  routeStartedAt: number;
  error: unknown;
}) {
  const providerError = describeOpenAIError(input.error);
  const errorCode = providerError.code
    ?? (input.error instanceof Error ? input.error.message.split(":", 1)[0] : "AGENT_RUN_FAILED");
  const failed = await input.queryable.query<{ id: string }>(
    `update agent_runs set status = 'failed', error_code = $3, error_message = $4,
       steps_used = least(max_steps, greatest(steps_used, 1)), finished_at = now(),
       lease_owner = null, lease_expires_at = null, heartbeat_at = null
     where id = $1 and status = 'running' and lease_owner = $2 returning id::text as id`,
    [input.runId, input.workerId, errorCode.slice(0, 160), providerError.message.slice(0, 1000)],
  );
  if (!failed.rows[0]) return false;
  await input.queryable.query(
    `update agent_steps set status = 'failed', error_code = $2, error_message = $3, finished_at = now()
     where run_id = $1 and status = 'running'`,
    [input.runId, errorCode.slice(0, 160), providerError.message.slice(0, 1000)],
  );
  if (input.route) {
    await finishProviderRouteDecision({
      queryable: input.queryable, decisionId: input.route.decisionId, usage: input.routeUsage,
      latencyMs: performance.now() - input.routeStartedAt, errorCode,
    });
  }
  await input.queryable.query(
    `insert into agent_messages (public_id, thread_id, role, content, metadata)
     values ($1, $2, 'assistant', $3, $4::jsonb)`,
    [
      createPublicId("agm"), input.threadId, `本轮执行未完成：${providerError.message}`,
      JSON.stringify({ runPublicId: input.runPublicId, errorCode }),
    ],
  );
  await input.queryable.query("update agent_threads set updated_at = now() where id = $1", [input.threadId]);
  return true;
}

async function blockClaimedAgentRun(input: {
  queryable: Queryable;
  runId: string;
  workerId: string;
  threadId: string;
  runPublicId: string;
  route: Awaited<ReturnType<typeof resolveProviderRoute>>;
  routeUsage: { input_tokens: number; output_tokens: number };
  routeStartedAt: number;
  error: AgentRunBlockedError;
}) {
  const blocked = await input.queryable.query<{ id: string }>(
    `update agent_runs set status = 'blocked', error_code = $3, error_message = $4,
       steps_used = least(max_steps, greatest(steps_used, $5)), finished_at = now(),
       lease_owner = null, lease_expires_at = null, heartbeat_at = null
     where id = $1 and status = 'running' and lease_owner = $2 returning id::text as id`,
    [input.runId, input.workerId, input.error.code, input.error.message.slice(0, 1000), Math.ceil(input.error.sequence / 2)],
  );
  if (!blocked.rows[0]) return false;
  await input.queryable.query(
    `insert into agent_steps (
       public_id, run_id, sequence, kind, status, decision_summary, tool_name, input,
       request_hash, error_code, error_message, finished_at
     ) values ($1, $2, $3, 'tool', 'blocked', $4, 'governance', $5::jsonb, $6, $7, $8, now())
     on conflict (run_id, sequence) do update set
       status = 'blocked', error_code = excluded.error_code,
       error_message = excluded.error_message, finished_at = now()`,
    [
      createPublicId("ags"), input.runId, input.error.sequence, input.error.message,
      JSON.stringify({ runPublicId: input.runPublicId, governanceCode: input.error.code }),
      hashJson({ runPublicId: input.runPublicId, governanceCode: input.error.code }),
      input.error.code, input.error.message.slice(0, 1000),
    ],
  );
  if (input.route) {
    await finishProviderRouteDecision({
      queryable: input.queryable, decisionId: input.route.decisionId, usage: input.routeUsage,
      latencyMs: performance.now() - input.routeStartedAt, errorCode: input.error.code,
    });
  }
  await input.queryable.query(
    `insert into agent_messages (public_id, thread_id, role, content, metadata)
     values ($1, $2, 'assistant', $3, $4::jsonb)`,
    [
      createPublicId("agm"), input.threadId, `本轮已停止：${input.error.message}`,
      JSON.stringify({ runPublicId: input.runPublicId, errorCode: input.error.code, status: "blocked" }),
    ],
  );
  await input.queryable.query("update agent_threads set updated_at = now() where id = $1", [input.threadId]);
  return true;
}

async function executeClaimedAgentRun(input: {
  runId: string;
  workerId: string;
  decide: AgentDecisionProvider;
}) {
  const database = await getDatabase();
  const claimed = await database.query<{ public_id: string; thread_id: string }>(
    `select public_id, thread_id::text as thread_id from agent_runs
     where id = $1 and status = 'running' and lease_owner = $2`,
    [input.runId, input.workerId],
  );
  if (!claimed.rows[0]) throw new Error("AGENT_RUN_NOT_CLAIMED");
  let route: Awaited<ReturnType<typeof resolveProviderRoute>> = null;
  let routeUsage = { input_tokens: 0, output_tokens: 0 };
  let routeStartedAt = performance.now();
  try {
    const runResult = await database.query<{
      id: string; public_id: string; thread_id: string; workspace_id: string; objective: string;
      max_steps: number; external_execution_allowed: boolean; user_public_id: string;
      max_tool_calls: number; tool_calls_used: number;
      max_product_tool_calls: number; product_tool_calls_used: number;
      max_external_tool_calls: number; external_tool_calls_used: number;
      token_budget: string; input_tokens_used: string; output_tokens_used: string;
      max_cost_micros: string; cost_micros_used: string;
      display_name: string; email: string; workspace_public_id: string; workspace_name: string;
      role: Viewer["role"]; token_balance: string; user_id: string;
    }>(
      `select run.id::text as id, run.public_id, run.thread_id::text as thread_id,
              run.workspace_id::text as workspace_id, run.objective, run.max_steps,
              run.max_tool_calls, run.tool_calls_used, run.max_product_tool_calls, run.product_tool_calls_used,
              run.max_external_tool_calls, run.external_tool_calls_used, run.token_budget::text as token_budget,
              run.input_tokens_used::text as input_tokens_used, run.output_tokens_used::text as output_tokens_used,
              run.max_cost_micros::text as max_cost_micros, run.cost_micros_used::text as cost_micros_used,
              run.external_execution_allowed, actor.id::text as user_id, actor.public_id as user_public_id,
              actor.display_name, actor.email, workspace.public_id as workspace_public_id,
              workspace.name as workspace_name, member.role, workspace.token_balance::text as token_balance
       from agent_runs run
       join users actor on actor.id = run.initiated_by
       join workspaces workspace on workspace.id = run.workspace_id
       join workspace_members member on member.workspace_id = run.workspace_id and member.user_id = actor.id
       where run.id = $1 and run.status = 'running' and run.lease_owner = $2`,
      [input.runId, input.workerId],
    );
    const run = runResult.rows[0];
    if (!run) throw new Error("AGENT_RUN_ACTOR_UNAVAILABLE");
    const viewer: Viewer = {
      userId: run.user_id, userPublicId: run.user_public_id, displayName: run.display_name,
      email: run.email, workspaceId: run.workspace_id, workspacePublicId: run.workspace_public_id,
      workspaceName: run.workspace_name, role: run.role, tokenBalance: Number(run.token_balance),
    };
    const [history, files, bindings] = await Promise.all([
      database.query<{ role: "user" | "assistant" | "system" | "tool"; content: string }>(
        "select role, content from agent_messages where thread_id = $1 order by created_at desc, id desc limit 40",
        [run.thread_id],
      ),
      database.query<{ path: string; byte_size: number; version: number }>(
        "select path, byte_size, version from agent_workspace_files where workspace_id = $1 order by path limit 200",
        [viewer.workspaceId],
      ),
      loadAgentRunSkillBindings(database, run.id),
    ]);
    const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = history.rows.reverse().map((message) => ({
      role: message.role === "tool" ? "system" : message.role,
      content: message.role === "tool" ? `工具结果：${message.content}` : message.content,
    }));
    route = await database.transaction((transaction) => resolveProviderRoute({
      queryable: transaction, workspaceId: viewer.workspaceId, runId: run.id,
      taskId: null, stage: "reasoning", subjectKey: `${viewer.workspacePublicId}:${run.public_id}`,
      runtimeKind: "agent",
    }));
    routeStartedAt = performance.now();
    let inputTokensUsed = Number(run.input_tokens_used);
    let outputTokensUsed = Number(run.output_tokens_used);
    let costMicrosUsed = Number(run.cost_micros_used);
    let toolCallsUsed = run.tool_calls_used;
    let productToolCallsUsed = run.product_tool_calls_used;
    let externalToolCallsUsed = run.external_tool_calls_used;
    for (let sequence = 1; sequence <= run.max_steps; sequence += 1) {
      const estimatedInputTokens = route?.estimatedInputTokens ?? 0;
      const estimatedOutputTokens = route?.estimatedOutputTokens ?? 0;
      const estimatedCost = providerCostMicros(estimatedInputTokens, estimatedOutputTokens, route);
      if (inputTokensUsed + outputTokensUsed + estimatedInputTokens + estimatedOutputTokens > Number(run.token_budget)) {
        throw new AgentRunBlockedError("AGENT_TOKEN_BUDGET_EXCEEDED", "Agent Run 的 token 预算不足以开始下一轮模型决策。", sequence * 2 - 1);
      }
      if (costMicrosUsed + estimatedCost > Number(run.max_cost_micros)) {
        throw new AgentRunBlockedError("AGENT_COST_BUDGET_EXCEEDED", "Agent Run 的费用预算不足以开始下一轮模型决策。", sequence * 2 - 1);
      }
      const decisionInput = {
        objective: run.objective, userPublicId: viewer.userPublicId, messages,
        skills: bindings.map((binding) => ({
          publicId: binding.public_id, slug: binding.slug, name: binding.name,
          description: "受治理的工作区 Skill", version: binding.version, executorType: binding.executor_type,
        })),
        files: files.rows.map((file) => ({ path: file.path, byteSize: file.byte_size, version: file.version })),
        externalExecutionAllowed: run.external_execution_allowed,
        productToolCatalog: formatUniversalAgentProductToolCatalog(),
      };
      const decision = await withAgentRunLeaseHeartbeat({
        queryable: database,
        runId: run.id,
        workerId: input.workerId,
        execute: () => route
          ? withProviderRoute(route.override, () => input.decide(decisionInput))
          : input.decide(decisionInput),
      });
      const currentUsage = tokenUsage(decision.usage);
      routeUsage = {
        input_tokens: routeUsage.input_tokens + currentUsage.input_tokens,
        output_tokens: routeUsage.output_tokens + currentUsage.output_tokens,
      };
      inputTokensUsed += currentUsage.input_tokens;
      outputTokensUsed += currentUsage.output_tokens;
      const cumulativeCostMicros = Math.max(costMicrosUsed, providerCostMicros(inputTokensUsed, outputTokensUsed, route));
      const currentCostMicros = Math.max(0, cumulativeCostMicros - costMicrosUsed);
      costMicrosUsed = cumulativeCostMicros;
      const usageRecorded = await database.query<{ id: string }>(
        `update agent_runs set input_tokens_used = input_tokens_used + $3,
           output_tokens_used = output_tokens_used + $4, cost_micros_used = cost_micros_used + $5,
           heartbeat_at = now(), lease_expires_at = now() + ($6::double precision * interval '1 millisecond')
         where id = $1 and status = 'running' and lease_owner = $2 returning id::text as id`,
        [run.id, input.workerId, currentUsage.input_tokens, currentUsage.output_tokens, currentCostMicros, AGENT_RUN_LEASE_MS],
      );
      if (!usageRecorded.rows[0]) throw new Error("AGENT_RUN_LEASE_LOST");
      const decisionPayload = {
        action: decision.action, message: decision.message, path: decision.path,
        skillPublicId: decision.skillPublicId, productToolName: decision.productToolName ?? null,
        argumentsJson: decision.argumentsJson ?? null,
        responseId: decision.responseId ?? null,
        model: decision.model ?? null, promptVersion: decision.promptVersion ?? null,
      };
      await database.query(
        `insert into agent_steps (
           public_id, run_id, sequence, kind, status, decision_summary, input, output,
           request_hash, response_hash, finished_at
         ) values ($1, $2, $3, 'decision', 'completed', $4, $5::jsonb, $6::jsonb, $7, $8, now())`,
        [
          createPublicId("ags"), run.id, sequence * 2 - 1, decision.decisionSummary,
          JSON.stringify({ objective: run.objective, priorMessageCount: messages.length }),
          JSON.stringify(decisionPayload), hashJson({ objective: run.objective, priorMessageCount: messages.length }),
          hashJson(decisionPayload),
        ],
      );
      if (inputTokensUsed + outputTokensUsed > Number(run.token_budget)) {
        throw new AgentRunBlockedError("AGENT_TOKEN_BUDGET_EXCEEDED", "Agent Run 已达到 token 预算上限，未执行模型请求的后续动作。", sequence * 2);
      }
      if (costMicrosUsed > Number(run.max_cost_micros)) {
        throw new AgentRunBlockedError("AGENT_COST_BUDGET_EXCEEDED", "Agent Run 已达到费用预算上限，未执行模型请求的后续动作。", sequence * 2);
      }
      if (decision.action === "finish") {
        const content = decision.message.trim() || "任务已完成。";
        return database.transaction(async (transaction) => {
          const completed = await transaction.query<{ id: string }>(
            `update agent_runs set status = 'completed', steps_used = $3, finished_at = now(),
               lease_owner = null, lease_expires_at = null, heartbeat_at = null
             where id = $1 and status = 'running' and lease_owner = $2 returning id::text as id`,
            [run.id, input.workerId, sequence],
          );
          if (!completed.rows[0]) throw new Error("AGENT_RUN_LEASE_LOST");
          if (route) {
            await finishProviderRouteDecision({
              queryable: transaction, decisionId: route.decisionId, usage: routeUsage,
              latencyMs: performance.now() - routeStartedAt, qualityScore: 100,
            });
          }
          const assistant = await transaction.query<{ public_id: string }>(
            `insert into agent_messages (public_id, thread_id, role, content, metadata)
             values ($1, $2, 'assistant', $3, $4::jsonb) returning public_id`,
            [createPublicId("agm"), run.thread_id, content, JSON.stringify({ runPublicId: run.public_id, model: decision.model ?? null })],
          );
          await transaction.query("update agent_threads set updated_at = now() where id = $1", [run.thread_id]);
          return { runPublicId: run.public_id, messagePublicId: assistant.rows[0].public_id, status: "completed" as const };
        });
      }
      const productToolCall = decision.action === "execute_product_tool";
      const externalToolCall = decision.action === "execute_skill";
      if (toolCallsUsed >= run.max_tool_calls) {
        throw new AgentRunBlockedError("AGENT_TOOL_CALL_LIMIT_EXCEEDED", "Agent Run 已达到总工具调用上限。", sequence * 2);
      }
      if (productToolCall && productToolCallsUsed >= run.max_product_tool_calls) {
        throw new AgentRunBlockedError("AGENT_PRODUCT_TOOL_CALL_LIMIT_EXCEEDED", "Agent Run 已达到原生产品工具调用上限。", sequence * 2);
      }
      if (externalToolCall && externalToolCallsUsed >= run.max_external_tool_calls) {
        throw new AgentRunBlockedError("AGENT_EXTERNAL_TOOL_CALL_LIMIT_EXCEEDED", "Agent Run 已达到外部 Skill 调用上限。", sequence * 2);
      }
      toolCallsUsed += 1;
      if (productToolCall) productToolCallsUsed += 1;
      if (externalToolCall) externalToolCallsUsed += 1;
      const toolCallRecorded = await database.query<{ id: string }>(
        `update agent_runs set tool_calls_used = tool_calls_used + 1,
           product_tool_calls_used = product_tool_calls_used + $3,
           external_tool_calls_used = external_tool_calls_used + $4
         where id = $1 and status = 'running' and lease_owner = $2
           and tool_calls_used < max_tool_calls
           and ($3 = 0 or product_tool_calls_used < max_product_tool_calls)
           and ($4 = 0 or external_tool_calls_used < max_external_tool_calls)
         returning id::text as id`,
        [run.id, input.workerId, productToolCall ? 1 : 0, externalToolCall ? 1 : 0],
      );
      if (!toolCallRecorded.rows[0]) {
        throw new AgentRunBlockedError("AGENT_TOOL_CALL_LIMIT_EXCEEDED", "Agent Run 的工具调用配额已用尽。", sequence * 2);
      }
      const toolStep = await database.query<{ id: string }>(
        `insert into agent_steps (
           public_id, run_id, sequence, kind, status, decision_summary, tool_name, input, request_hash
         ) values ($1, $2, $3, 'tool', 'running', $4, $5, $6::jsonb, $7) returning id::text as id`,
        [
          createPublicId("ags"), run.id, sequence * 2, decision.decisionSummary,
          decision.action, JSON.stringify(decisionPayload), hashJson(decisionPayload),
        ],
      );
      try {
        const toolOutput = await withAgentRunLeaseHeartbeat({
          queryable: database,
          runId: run.id,
          workerId: input.workerId,
          execute: () => executeAgentTool({
            queryable: database, viewer, runId: run.id, stepId: toolStep.rows[0].id,
            decision, bindings, externalExecutionAllowed: run.external_execution_allowed,
          }),
        });
        await database.query(
          `update agent_steps set status = 'completed', output = $2::jsonb,
             response_hash = $3, finished_at = now() where id = $1`,
          [toolStep.rows[0].id, JSON.stringify(toolOutput), hashJson(toolOutput)],
        );
        messages.push({ role: "assistant", content: `动作 ${decision.action}：${decision.message}` });
        messages.push({ role: "system", content: `工具 ${decision.action} 结果：${JSON.stringify(toolOutput)}` });
      } catch (error) {
        const code = error instanceof SkillExecutionError ? error.code : error instanceof Error ? error.message : "AGENT_TOOL_FAILED";
        await database.query(
          `update agent_steps set status = 'failed', error_code = $2,
             error_message = $3, finished_at = now() where id = $1`,
          [toolStep.rows[0].id, code.slice(0, 160), (error instanceof Error ? error.message : "Agent tool failed").slice(0, 1000)],
        );
        messages.push({ role: "system", content: `工具 ${decision.action} 失败：${code}` });
      }
      const advanced = await database.query<{ id: string }>(
        `update agent_runs set steps_used = $3, heartbeat_at = now(),
           lease_expires_at = now() + ($4::double precision * interval '1 millisecond')
         where id = $1 and status = 'running' and lease_owner = $2 returning id::text as id`,
        [run.id, input.workerId, sequence, AGENT_RUN_LEASE_MS],
      );
      if (!advanced.rows[0]) throw new Error("AGENT_RUN_LEASE_LOST");
    }
    throw new Error("AGENT_MAX_STEPS_EXCEEDED");
  } catch (error) {
    if (error instanceof AgentRunBlockedError) {
      await database.transaction((transaction) => blockClaimedAgentRun({
        queryable: transaction, runId: input.runId, workerId: input.workerId,
        threadId: claimed.rows[0].thread_id, runPublicId: claimed.rows[0].public_id,
        route, routeUsage, routeStartedAt, error,
      }));
      return { runPublicId: claimed.rows[0].public_id, status: "blocked" as const };
    }
    await database.transaction((transaction) => failClaimedAgentRun({
      queryable: transaction, runId: input.runId, workerId: input.workerId,
      threadId: claimed.rows[0].thread_id, runPublicId: claimed.rows[0].public_id,
      route, routeUsage, routeStartedAt, error,
    }));
    return { runPublicId: claimed.rows[0].public_id, status: "failed" as const };
  }
}

export async function processAgentRunQueue(input: {
  workerId: string;
  maxRuns?: number;
  runPublicId?: string;
  decide?: AgentDecisionProvider;
}) {
  const database = await getDatabase();
  const workerId = input.workerId.trim().slice(0, 160);
  if (!workerId) throw new Error("AGENT_WORKER_ID_REQUIRED");
  const maxRuns = Math.min(10, Math.max(1, input.maxRuns ?? 1));
  let processed = 0;
  while (processed < maxRuns) {
    const claimed = await database.transaction((transaction) => claimAgentRun(transaction, workerId, input.runPublicId));
    if (!claimed) break;
    try {
      await executeClaimedAgentRun({
        runId: claimed.id,
        workerId,
        decide: input.decide ?? generateProviderUniversalAgentTurn,
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "agent_run_worker_error",
        runPublicId: claimed.public_id,
        message: error instanceof Error ? error.message : "unknown",
      }));
    }
    processed += 1;
  }
  return processed;
}
