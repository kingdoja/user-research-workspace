import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import {
  executeConfiguredSkill,
  hashJson,
  SkillExecutionError,
  skillExecutorConfigSchema,
  type SkillExecutorConfig,
} from "@/lib/skill-executor";

export type SkillContract = {
  slug: string;
  version: number;
  name: string;
  description: string;
  capabilities: string[];
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
};

export type SkillSummary = {
  publicId: string | null;
  slug: string;
  version: number;
  name: string;
  description: string;
  capabilities: string[];
  source: "builtin" | "workspace";
  status: "active" | "draft" | "archived";
  executable: boolean;
  enabled: boolean;
  executorType: "builtin" | "unconfigured" | "declarative_http" | "mcp";
  contentHash: string | null;
};

export type RunSkillBinding = {
  id: string;
  publicId: string;
  slug: string;
  version: number;
  executorType: "builtin" | "declarative_http" | "mcp";
  enabledAtLock: boolean;
  contentHash: string;
};

const optionalExecutorSchema = skillExecutorConfigSchema.nullable().default(null);

export const skillManifestInputSchema = z.object({
  slug: z.string().trim().min(2).max(80).regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(""),
  visibility: z.enum(["private", "workspace"]).default("workspace"),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  executor: optionalExecutorSchema,
});

export const skillVersionInputSchema = z.object({
  description: z.string().trim().max(1000).optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  promptVersion: z.string().trim().min(1).max(120).nullable().default(null),
  changeNote: z.string().trim().max(500).default(""),
  executor: optionalExecutorSchema,
});

export const skillActivationInputSchema = z.object({
  source: z.enum(["builtin", "workspace"]),
  slug: z.string().trim().min(2).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  publicId: z.string().trim().min(1).nullable().default(null),
  enabled: z.boolean(),
});

export const skillExecutionInputSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
});

function executorStorage(executor: SkillExecutorConfig | null) {
  return {
    type: executor?.kind ?? "unconfigured",
    config: executor ?? {},
  };
}

function versionHash(input: {
  version: number;
  capabilities: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  promptVersion: string | null;
  executor: SkillExecutorConfig | null;
  changeNote?: string;
}) {
  const executor = executorStorage(input.executor);
  return hashJson({
    version: input.version,
    capabilities: input.capabilities,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    promptVersion: input.promptVersion,
    executorType: executor.type,
    executorConfig: executor.config,
    changeNote: input.changeNote ?? "",
  });
}

export function describeBuiltInSkills(contracts: SkillContract[]): SkillSummary[] {
  return contracts.map((contract) => ({
    publicId: null,
    slug: contract.slug,
    version: contract.version,
    name: contract.name,
    description: contract.description,
    capabilities: contract.capabilities,
    source: "builtin",
    status: "active",
    executable: true,
    enabled: true,
    executorType: "builtin",
    contentHash: hashJson({ source: "builtin", slug: contract.slug, version: contract.version, executorType: "builtin" }),
  }));
}

export function resolveBuiltInSkill<Skill extends { version: number }>(
  registry: Record<string, Skill>,
  slug: string,
) {
  const skill = registry[slug];
  if (!skill) throw new Error(`SKILL_NOT_FOUND:${slug}`);
  return skill;
}

async function listSettings(queryable: Queryable, workspaceId: string) {
  const result = await queryable.query<{
    skill_source: "builtin" | "workspace";
    skill_slug: string;
    enabled: boolean;
    pinned_version: number | null;
  }>(
    `select skill_source, skill_slug, enabled, pinned_version
     from workspace_skill_settings where workspace_id = $1`,
    [workspaceId],
  );
  return new Map(result.rows.map((row) => [`${row.skill_source}:${row.skill_slug}`, row]));
}

export async function listWorkspaceSkills(viewer: Viewer): Promise<SkillSummary[]> {
  const database = await getDatabase();
  const [result, settings] = await Promise.all([
    database.query<{
      public_id: string;
      slug: string;
      name: string;
      description: string;
      status: "active" | "draft" | "archived";
      latest_version: number;
      manifest: { capabilities?: string[] } | string;
      executor_type: "unconfigured" | "declarative_http" | "mcp";
      content_hash: string;
    }>(
      `select skill.public_id, skill.slug, skill.name, skill.description, skill.status,
              skill.latest_version, version.manifest, version.executor_type, version.content_hash
       from skill_manifests skill
       join skill_versions version on version.skill_id = skill.id and version.version = skill.latest_version
       where skill.workspace_id = $1
         and (skill.visibility = 'workspace' or skill.owner_user_id = $2)
       order by skill.updated_at desc, skill.id desc`,
      [viewer.workspaceId, viewer.userId],
    ),
    listSettings(database, viewer.workspaceId),
  ]);
  return result.rows.map((row) => {
    const manifest = typeof row.manifest === "string" ? JSON.parse(row.manifest) as { capabilities?: string[] } : row.manifest;
    const setting = settings.get(`workspace:${row.slug}`);
    const executable = row.executor_type !== "unconfigured";
    return {
      publicId: row.public_id,
      slug: row.slug,
      version: setting?.pinned_version ?? row.latest_version,
      name: row.name,
      description: row.description,
      capabilities: manifest.capabilities ?? [],
      source: "workspace" as const,
      status: row.status,
      executable,
      enabled: executable && row.status !== "archived" && (setting?.enabled ?? false),
      executorType: row.executor_type,
      contentHash: row.content_hash,
    };
  });
}

export async function listSkillCatalog(viewer: Viewer, builtins: SkillSummary[]) {
  const database = await getDatabase();
  const [workspaceSkills, settings] = await Promise.all([
    listWorkspaceSkills(viewer),
    listSettings(database, viewer.workspaceId),
  ]);
  return [
    ...builtins.map((skill) => ({
      ...skill,
      enabled: settings.get(`builtin:${skill.slug}`)?.enabled ?? true,
    })),
    ...workspaceSkills,
  ];
}

export async function isWorkspaceSkillEnabled(
  workspaceId: string,
  source: "builtin" | "workspace",
  slug: string,
  defaultEnabled = source === "builtin",
) {
  const database = await getDatabase();
  const result = await database.query<{ enabled: boolean }>(
    `select enabled from workspace_skill_settings
     where workspace_id = $1 and skill_source = $2 and skill_slug = $3 limit 1`,
    [workspaceId, source, slug],
  );
  return result.rows[0]?.enabled ?? defaultEnabled;
}

export async function createWorkspaceSkill(
  viewer: Viewer,
  input: z.infer<typeof skillManifestInputSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const inserted = await transaction.query<{ id: string; public_id: string }>(
      `insert into skill_manifests (
         public_id, workspace_id, owner_user_id, slug, name, description, visibility
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (workspace_id, slug) do nothing
       returning id::text as id, public_id`,
      [createPublicId("skl"), viewer.workspaceId, viewer.userId, input.slug, input.name, input.description, input.visibility],
    );
    const skill = inserted.rows[0];
    if (!skill) return "conflict" as const;
    const executor = executorStorage(input.executor);
    const contentHash = versionHash({
      version: 1,
      capabilities: input.capabilities,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      promptVersion: null,
      executor: input.executor,
    });
    await transaction.query(
      `insert into skill_versions (
         public_id, skill_id, version, manifest, input_schema, output_schema,
         executor_type, executor_config, content_hash
       ) values ($1, $2, 1, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8)`,
      [
        createPublicId("skv"), skill.id,
        JSON.stringify({ capabilities: input.capabilities }),
        JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema),
        executor.type, JSON.stringify(executor.config), contentHash,
      ],
    );
    await transaction.query(
      `insert into workspace_skill_settings (
         workspace_id, skill_id, skill_source, skill_slug, enabled, updated_by
       ) values ($1, $2, 'workspace', $3, false, $4)`,
      [viewer.workspaceId, skill.id, input.slug, viewer.userId],
    );
    await transaction.query(
      `insert into skill_events (skill_id, workspace_id, actor_user_id, event_type, payload)
       values ($1, $2, $3, 'skill.created', $4::jsonb)`,
      [skill.id, viewer.workspaceId, viewer.userId, JSON.stringify({ version: 1, executorType: executor.type, contentHash })],
    );
    return { publicId: skill.public_id, version: 1, contentHash };
  });
}

export async function publishWorkspaceSkillVersion(
  viewer: Viewer,
  publicId: string,
  input: z.infer<typeof skillVersionInputSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; latest_version: number; owner_user_id: string }>(
      `select id::text as id, latest_version, owner_user_id::text as owner_user_id
       from skill_manifests where public_id = $1 and workspace_id = $2 for update`,
      [publicId, viewer.workspaceId],
    );
    const skill = result.rows[0];
    if (!skill) return "not_found" as const;
    if (viewer.role === "member" && skill.owner_user_id !== viewer.userId) return "forbidden" as const;
    const version = skill.latest_version + 1;
    const executor = executorStorage(input.executor);
    const contentHash = versionHash({
      version,
      capabilities: input.capabilities,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      promptVersion: input.promptVersion,
      executor: input.executor,
      changeNote: input.changeNote,
    });
    await transaction.query(
      `insert into skill_versions (
         public_id, skill_id, version, manifest, input_schema, output_schema, prompt_version,
         executor_type, executor_config, content_hash
       ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, $10)`,
      [
        createPublicId("skv"), skill.id, version,
        JSON.stringify({ capabilities: input.capabilities, changeNote: input.changeNote }),
        JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema), input.promptVersion,
        executor.type, JSON.stringify(executor.config), contentHash,
      ],
    );
    await transaction.query(
      `update skill_manifests set latest_version = $2,
              description = coalesce($3, description), updated_at = now()
       where id = $1`,
      [skill.id, version, input.description ?? null],
    );
    await transaction.query(
      `insert into skill_events (skill_id, workspace_id, actor_user_id, event_type, payload)
       values ($1, $2, $3, 'skill.version.published', $4::jsonb)`,
      [skill.id, viewer.workspaceId, viewer.userId, JSON.stringify({ version, changeNote: input.changeNote, executorType: executor.type, contentHash })],
    );
    return { publicId, version, contentHash };
  });
}

export async function setWorkspaceSkillEnabled(
  viewer: Viewer,
  input: z.infer<typeof skillActivationInputSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    let skillId: string | null = null;
    let pinnedVersion: number | null = null;
    if (input.source === "builtin") {
      if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
    } else {
      const result = await transaction.query<{
        id: string; owner_user_id: string; latest_version: number; status: string; executor_type: string;
      }>(
        `select skill.id::text as id, skill.owner_user_id::text as owner_user_id,
                skill.latest_version, skill.status, version.executor_type
         from skill_manifests skill
         join skill_versions version on version.skill_id = skill.id and version.version = skill.latest_version
         where skill.workspace_id = $1 and skill.public_id = $2 and skill.slug = $3
         for update of skill`,
        [viewer.workspaceId, input.publicId, input.slug],
      );
      const skill = result.rows[0];
      if (!skill) return "not_found" as const;
      if (viewer.role === "member" && skill.owner_user_id !== viewer.userId) return "forbidden" as const;
      if (input.enabled && skill.executor_type === "unconfigured") return "unconfigured" as const;
      if (input.enabled && skill.status === "archived") return "archived" as const;
      skillId = skill.id;
      pinnedVersion = skill.latest_version;
      if (input.enabled && skill.status === "draft") {
        await transaction.query("update skill_manifests set status = 'active', updated_at = now() where id = $1", [skill.id]);
      }
    }
    await transaction.query(
      `insert into workspace_skill_settings (
         workspace_id, skill_id, skill_source, skill_slug, enabled, pinned_version, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (workspace_id, skill_source, skill_slug) do update set
         skill_id = excluded.skill_id, enabled = excluded.enabled,
         pinned_version = excluded.pinned_version, updated_by = excluded.updated_by, updated_at = now()`,
      [viewer.workspaceId, skillId, input.source, input.slug, input.enabled, pinnedVersion, viewer.userId],
    );
    await transaction.query(
      `insert into skill_control_events (
         workspace_id, skill_id, actor_user_id, skill_source, skill_slug, event_type, payload
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        viewer.workspaceId, skillId, viewer.userId, input.source, input.slug,
        input.enabled ? "skill.enabled" : "skill.disabled",
        JSON.stringify({ enabled: input.enabled, pinnedVersion }),
      ],
    );
    return { enabled: input.enabled, pinnedVersion };
  });
}

export async function lockRunBuiltInSkills(input: {
  queryable: Queryable;
  workspaceId: string;
  studyId: string;
  runId: string;
  skills: Array<{ slug: string; version: number }>;
}) {
  const unique = [...new Map(input.skills.map((skill) => [skill.slug, skill])).values()];
  const settings = await listSettings(input.queryable, input.workspaceId);
  for (const skill of unique) {
    const enabled = settings.get(`builtin:${skill.slug}`)?.enabled ?? true;
    const contentHash = hashJson({ source: "builtin", slug: skill.slug, version: skill.version, executorType: "builtin" });
    await input.queryable.query(
      `insert into study_run_skill_bindings (
         public_id, workspace_id, study_id, run_id, skill_source, skill_slug, skill_version,
         executor_type, executor_config, input_schema, output_schema, content_hash, enabled_at_lock
       ) values ($1, $2, $3, $4, 'builtin', $5, $6, 'builtin', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $7, $8)
       on conflict (run_id, skill_slug) do nothing`,
      [createPublicId("skb"), input.workspaceId, input.studyId, input.runId, skill.slug, skill.version, contentHash, enabled],
    );
  }
}

export async function getRunSkillBinding(runId: string, slug: string): Promise<RunSkillBinding | null> {
  const database = await getDatabase();
  const result = await database.query<{
    id: string; public_id: string; skill_slug: string; skill_version: number;
    executor_type: RunSkillBinding["executorType"]; enabled_at_lock: boolean; content_hash: string;
  }>(
    `select id::text as id, public_id, skill_slug, skill_version, executor_type, enabled_at_lock, content_hash
     from study_run_skill_bindings where run_id = $1 and skill_slug = $2 limit 1`,
    [runId, slug],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    publicId: row.public_id,
    slug: row.skill_slug,
    version: row.skill_version,
    executorType: row.executor_type,
    enabledAtLock: row.enabled_at_lock,
    contentHash: row.content_hash,
  } : null;
}

export async function executeWorkspaceSkill(
  viewer: Viewer,
  publicId: string,
  argumentsInput: Record<string, unknown>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{
    skill_id: string;
    skill_version_id: string;
    owner_user_id: string;
    visibility: string;
    enabled: boolean | null;
    version: number;
    executor_type: "unconfigured" | "declarative_http" | "mcp";
    executor_config: Record<string, unknown> | string;
    input_schema: Record<string, unknown> | string;
    output_schema: Record<string, unknown> | string;
  }>(
    `select skill.id::text as skill_id, version.id::text as skill_version_id,
            skill.owner_user_id::text as owner_user_id, skill.visibility,
            setting.enabled, version.version, version.executor_type, version.executor_config,
            version.input_schema, version.output_schema
     from skill_manifests skill
     join workspace_skill_settings setting on setting.workspace_id = skill.workspace_id
       and setting.skill_source = 'workspace' and setting.skill_slug = skill.slug and setting.skill_id = skill.id
     join skill_versions version on version.skill_id = skill.id
       and version.version = coalesce(setting.pinned_version, skill.latest_version)
     where skill.public_id = $1 and skill.workspace_id = $2 and skill.status = 'active'
       and (skill.visibility = 'workspace' or skill.owner_user_id = $3)
     limit 1`,
    [publicId, viewer.workspaceId, viewer.userId],
  );
  const skill = result.rows[0];
  if (!skill) return "not_found" as const;
  if (!skill.enabled) return "disabled" as const;
  if (skill.executor_type === "unconfigured") return "unconfigured" as const;
  const configValue = typeof skill.executor_config === "string" ? JSON.parse(skill.executor_config) : skill.executor_config;
  const parsedConfig = skillExecutorConfigSchema.safeParse(configValue);
  if (!parsedConfig.success || parsedConfig.data.kind !== skill.executor_type) return "unconfigured" as const;
  const inputSchema = typeof skill.input_schema === "string" ? JSON.parse(skill.input_schema) : skill.input_schema;
  const outputSchema = typeof skill.output_schema === "string" ? JSON.parse(skill.output_schema) : skill.output_schema;
  const requestHash = hashJson(argumentsInput);
  const execution = await database.query<{ id: string; public_id: string }>(
    `insert into skill_executions (
       public_id, workspace_id, skill_id, skill_version_id, actor_user_id,
       executor_type, input, request_hash
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     returning id::text as id, public_id`,
    [
      createPublicId("ske"), viewer.workspaceId, skill.skill_id, skill.skill_version_id,
      viewer.userId, skill.executor_type, JSON.stringify(argumentsInput), requestHash,
    ],
  );
  const executionRow = execution.rows[0];
  try {
    const output = await executeConfiguredSkill({
      config: parsedConfig.data,
      inputSchema,
      outputSchema,
      arguments: argumentsInput,
    });
    const responseHash = hashJson(output);
    await database.query(
      `update skill_executions set status = 'completed', output = $2::jsonb,
              response_hash = $3, finished_at = now() where id = $1`,
      [executionRow.id, JSON.stringify(output), responseHash],
    );
    return { publicId: executionRow.public_id, version: skill.version, output, requestHash, responseHash };
  } catch (error) {
    const code = error instanceof SkillExecutionError ? error.code : "SKILL_EXECUTION_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 1_000) : "Skill execution failed";
    await database.query(
      `update skill_executions set status = 'failed', error_code = $2,
              error_message = $3, finished_at = now() where id = $1`,
      [executionRow.id, code, message],
    );
    throw error;
  }
}
