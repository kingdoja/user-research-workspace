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

export const createAgentThreadInputSchema = z.object({
  title: z.string().trim().min(2).max(160),
}).strict();

export const sendAgentMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(12_000),
  skillPublicIds: z.array(z.string().trim().min(1).max(160)).max(12).default([]),
  externalExecutionAllowed: z.boolean().default(false),
}).strict();

export type UniversalAgentWorkspace = {
  provider: ReturnType<typeof getProviderStageStatus>;
  threads: Array<{
    publicId: string;
    title: string;
    status: "active" | "archived";
    updatedAt: string;
    lastMessage: string | null;
    lastRunStatus: "running" | "completed" | "failed" | "cancelled" | null;
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
  recentRuns: Array<{
    publicId: string;
    threadPublicId: string;
    status: "running" | "completed" | "failed" | "cancelled";
    stepsUsed: number;
    maxSteps: number;
    externalExecutionAllowed: boolean;
    startedAt: string;
  }>;
};

type AgentDecision = Omit<ProviderUniversalAgentTurn, "responseId" | "model" | "promptVersion" | "usage"> & {
  responseId?: string;
  model?: string;
  promptVersion?: string;
  usage?: unknown;
};

type AgentDecisionProvider = (input: Parameters<typeof generateProviderUniversalAgentTurn>[0]) => Promise<AgentDecision>;

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
  if (Array.isArray(origins) && origins.every((origin) => typeof origin === "string")) {
    return { allowedNetworkOrigins: origins.map((origin) => new URL(origin).origin) };
  }
  return { allowedNetworkOrigins: [new URL(config.endpoint).origin] };
}

function tokenUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return { input_tokens: 0, output_tokens: 0 };
  const value = usage as Record<string, unknown>;
  return {
    input_tokens: Number(value.input_tokens ?? value.prompt_tokens ?? 0) || 0,
    output_tokens: Number(value.output_tokens ?? value.completion_tokens ?? 0) || 0,
  };
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
      [viewer.workspaceId],
    ),
    database.query<{
      public_id: string; thread_public_id: string; status: UniversalAgentWorkspace["recentRuns"][number]["status"];
      steps_used: number; max_steps: number; external_execution_allowed: boolean; started_at: string;
    }>(
      `select run.public_id, thread.public_id as thread_public_id, run.status, run.steps_used,
              run.max_steps, run.external_execution_allowed, run.started_at::text as started_at
       from agent_runs run join agent_threads thread on thread.id = run.thread_id
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
    recentRuns: runsResult.rows.map((row) => ({
      publicId: row.public_id, threadPublicId: row.thread_public_id, status: row.status,
      stepsUsed: row.steps_used, maxSteps: row.max_steps,
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
) {
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
       and version.executor_type in ('declarative_http', 'mcp', 'sandbox')`,
    [viewer.workspaceId, uniqueIds],
  );
  if (result.rows.length !== uniqueIds.length) throw new Error("AGENT_SKILL_NOT_AVAILABLE");
  const bindings = [];
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
  binding: Awaited<ReturnType<typeof bindAgentSkills>>[number];
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
       public_id, workspace_id, skill_id, skill_version_id, actor_user_id, executor_type, input, request_hash
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) returning id::text as id, public_id`,
    [
      createPublicId("ske"), input.viewer.workspaceId, input.binding.skill_id, input.binding.version_id,
      input.viewer.userId, input.binding.executor_type, JSON.stringify(input.arguments), hashJson(input.arguments),
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
  bindings: Awaited<ReturnType<typeof bindAgentSkills>>;
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
  throw new Error("AGENT_TOOL_ACTION_INVALID");
}

export async function sendAgentMessage(
  viewer: Viewer,
  threadPublicId: string,
  input: z.infer<typeof sendAgentMessageInputSchema>,
  options?: { decide?: AgentDecisionProvider; maxSteps?: number },
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const maxSteps = Math.min(12, Math.max(1, options?.maxSteps ?? 6));
  const seeded = await database.transaction(async (transaction) => {
    const thread = await transaction.query<{ id: string; title: string }>(
      "select id::text as id, title from agent_threads where public_id = $1 and workspace_id = $2 and status = 'active' for update",
      [threadPublicId, viewer.workspaceId],
    );
    if (!thread.rows[0]) return null;
    const message = await transaction.query<{ id: string; public_id: string }>(
      `insert into agent_messages (public_id, thread_id, actor_user_id, role, content)
       values ($1, $2, $3, 'user', $4) returning id::text as id, public_id`,
      [createPublicId("agm"), thread.rows[0].id, viewer.userId, input.content],
    );
    const run = await transaction.query<{ id: string; public_id: string }>(
      `insert into agent_runs (
         public_id, workspace_id, thread_id, initiated_by, user_message_id, objective,
         max_steps, external_execution_allowed
       ) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id::text as id, public_id`,
      [
        createPublicId("agr"), viewer.workspaceId, thread.rows[0].id, viewer.userId,
        message.rows[0].id, input.content, maxSteps, input.externalExecutionAllowed,
      ],
    );
    const bindings = await bindAgentSkills(transaction, viewer, run.rows[0].id, input.skillPublicIds);
    await transaction.query("update agent_threads set updated_at = now() where id = $1", [thread.rows[0].id]);
    const route = await resolveProviderRoute({
      queryable: transaction, workspaceId: viewer.workspaceId, runId: run.rows[0].id,
      taskId: null, stage: "reasoning", subjectKey: `${viewer.workspacePublicId}:${run.rows[0].public_id}`,
      runtimeKind: "agent",
    });
    return { threadId: thread.rows[0].id, runId: run.rows[0].id, runPublicId: run.rows[0].public_id, bindings, route };
  });
  if (!seeded) return "not_found" as const;
  const history = await database.query<{ role: "user" | "assistant" | "system" | "tool"; content: string }>(
    `select role, content from agent_messages where thread_id = $1 order by created_at desc, id desc limit 40`,
    [seeded.threadId],
  );
  const files = await database.query<{ path: string; byte_size: number; version: number }>(
    "select path, byte_size, version from agent_workspace_files where workspace_id = $1 order by path limit 200",
    [viewer.workspaceId],
  );
  const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = history.rows.reverse().map((message) => ({
    role: message.role === "tool" ? "system" : message.role,
    content: message.role === "tool" ? `工具结果：${message.content}` : message.content,
  }));
  const decide = options?.decide ?? generateProviderUniversalAgentTurn;
  let routeUsage = { input_tokens: 0, output_tokens: 0 };
  const routeStartedAt = performance.now();
  try {
    for (let sequence = 1; sequence <= maxSteps; sequence += 1) {
      const decision = seeded.route
        ? await withProviderRoute(seeded.route.override, () => decide({
            objective: input.content, userPublicId: viewer.userPublicId, messages,
            skills: seeded.bindings.map((binding) => ({
              publicId: binding.public_id, slug: binding.slug, name: binding.name,
              description: "受治理的工作区 Skill", version: binding.version, executorType: binding.executor_type,
            })),
            files: files.rows.map((file) => ({ path: file.path, byteSize: file.byte_size, version: file.version })),
            externalExecutionAllowed: input.externalExecutionAllowed,
          }))
        : await decide({
            objective: input.content, userPublicId: viewer.userPublicId, messages,
            skills: seeded.bindings.map((binding) => ({
              publicId: binding.public_id, slug: binding.slug, name: binding.name,
              description: "受治理的工作区 Skill", version: binding.version, executorType: binding.executor_type,
            })),
            files: files.rows.map((file) => ({ path: file.path, byteSize: file.byte_size, version: file.version })),
            externalExecutionAllowed: input.externalExecutionAllowed,
          });
      const currentUsage = tokenUsage(decision.usage);
      routeUsage = {
        input_tokens: routeUsage.input_tokens + currentUsage.input_tokens,
        output_tokens: routeUsage.output_tokens + currentUsage.output_tokens,
      };
      const decisionPayload = {
        action: decision.action, message: decision.message, path: decision.path,
        skillPublicId: decision.skillPublicId, responseId: decision.responseId ?? null,
        model: decision.model ?? null, promptVersion: decision.promptVersion ?? null,
      };
      const decisionStep = await database.query<{ id: string }>(
        `insert into agent_steps (
           public_id, run_id, sequence, kind, status, decision_summary, input, output,
           request_hash, response_hash, finished_at
         ) values ($1, $2, $3, 'decision', 'completed', $4, $5::jsonb, $6::jsonb, $7, $8, now())
         returning id::text as id`,
        [
          createPublicId("ags"), seeded.runId, sequence * 2 - 1, decision.decisionSummary,
          JSON.stringify({ objective: input.content, priorMessageCount: messages.length }),
          JSON.stringify(decisionPayload), hashJson({ objective: input.content, priorMessageCount: messages.length }),
          hashJson(decisionPayload),
        ],
      );
      if (decision.action === "finish") {
        const content = decision.message.trim() || "任务已完成。";
        const assistant = await database.query<{ public_id: string }>(
          `insert into agent_messages (public_id, thread_id, role, content, metadata)
           values ($1, $2, 'assistant', $3, $4::jsonb) returning public_id`,
          [createPublicId("agm"), seeded.threadId, content, JSON.stringify({ runPublicId: seeded.runPublicId, model: decision.model ?? null })],
        );
        await database.query(
          `update agent_runs set status = 'completed', steps_used = $2, finished_at = now() where id = $1`,
          [seeded.runId, sequence],
        );
        await database.query("update agent_threads set updated_at = now() where id = $1", [seeded.threadId]);
        if (seeded.route) {
          await finishProviderRouteDecision({
            queryable: database, decisionId: seeded.route.decisionId, usage: routeUsage,
            latencyMs: performance.now() - routeStartedAt, qualityScore: 100,
          });
        }
        return { runPublicId: seeded.runPublicId, messagePublicId: assistant.rows[0].public_id, status: "completed" as const };
      }
      const toolStep = await database.query<{ id: string }>(
        `insert into agent_steps (
           public_id, run_id, sequence, kind, status, decision_summary, tool_name, input, request_hash
         ) values ($1, $2, $3, 'tool', 'running', $4, $5, $6::jsonb, $7) returning id::text as id`,
        [
          createPublicId("ags"), seeded.runId, sequence * 2, decision.decisionSummary,
          decision.action, JSON.stringify(decisionPayload), hashJson(decisionPayload),
        ],
      );
      try {
        const toolOutput = await executeAgentTool({
          queryable: database, viewer, runId: seeded.runId, stepId: toolStep.rows[0].id,
          decision, bindings: seeded.bindings, externalExecutionAllowed: input.externalExecutionAllowed,
        });
        await database.query(
          `update agent_steps set status = 'completed', output = $2::jsonb, response_hash = $3, finished_at = now() where id = $1`,
          [toolStep.rows[0].id, JSON.stringify(toolOutput), hashJson(toolOutput)],
        );
        messages.push({ role: "assistant", content: `动作 ${decision.action}：${decision.message}` });
        messages.push({ role: "system", content: `工具 ${decision.action} 结果：${JSON.stringify(toolOutput)}` });
      } catch (error) {
        const code = error instanceof SkillExecutionError ? error.code : error instanceof Error ? error.message : "AGENT_TOOL_FAILED";
        await database.query(
          `update agent_steps set status = 'failed', error_code = $2, error_message = $3, finished_at = now() where id = $1`,
          [toolStep.rows[0].id, code.slice(0, 160), (error instanceof Error ? error.message : "Agent tool failed").slice(0, 1000)],
        );
        messages.push({ role: "system", content: `工具 ${decision.action} 失败：${code}` });
      }
      await database.query("update agent_runs set steps_used = $2 where id = $1", [seeded.runId, sequence]);
      void decisionStep;
    }
    throw new Error("AGENT_MAX_STEPS_EXCEEDED");
  } catch (error) {
    const providerError = describeOpenAIError(error);
    const errorCode = providerError.code ?? (error instanceof Error ? error.message.split(":", 1)[0] : "AGENT_RUN_FAILED");
    await database.query(
      `update agent_runs set status = 'failed', error_code = $2, error_message = $3,
         steps_used = least(max_steps, greatest(steps_used, 1)), finished_at = now() where id = $1`,
      [seeded.runId, errorCode.slice(0, 160), providerError.message.slice(0, 1000)],
    );
    await database.query(
      `insert into agent_messages (public_id, thread_id, role, content, metadata)
       values ($1, $2, 'assistant', $3, $4::jsonb)`,
      [
        createPublicId("agm"), seeded.threadId,
        `本轮执行未完成：${providerError.message}`,
        JSON.stringify({ runPublicId: seeded.runPublicId, errorCode }),
      ],
    );
    if (seeded.route) {
      await finishProviderRouteDecision({
        queryable: database, decisionId: seeded.route.decisionId, usage: routeUsage,
        latencyMs: performance.now() - routeStartedAt, errorCode,
      });
    }
    throw error;
  }
}
