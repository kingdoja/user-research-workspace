import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import {
  executeConfiguredSkill,
  hashJson,
  probeConfiguredSkill,
  requiredExecutorCapabilities,
  SkillExecutionError,
  skillExecutorConfigSchema,
  type SkillExecutorConfig,
  type SkillExecutionPolicy,
} from "@/lib/skill-executor";

const skillCapabilityValues = ["network", "context_read", "files_read", "provider_invoke"] as const;
export type SkillCapability = typeof skillCapabilityValues[number];
export type SkillLifecycle = "draft" | "submitted" | "active" | "revoked" | "archived";
export type CapabilityGrant = { capability: SkillCapability; scope: Record<string, unknown> };

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
  status: SkillLifecycle;
  executable: boolean;
  enabled: boolean;
  executorType: "builtin" | "unconfigured" | "declarative_http" | "mcp";
  contentHash: string | null;
  packageFormat?: "inline" | "atypica.skill/v1";
  requestedCapabilities?: SkillCapability[];
  grantedCapabilities?: SkillCapability[];
  capabilityState?: "not_required" | "pending" | "granted";
  signatureState?: "not_applicable" | "not_provided" | "declared_unverified";
  health?: { status: "healthy" | "unhealthy"; checkedAt: string } | null;
};

export type RunSkillBinding = {
  id: string;
  publicId: string;
  slug: string;
  version: number;
  executorType: "builtin" | "declarative_http" | "mcp";
  enabledAtLock: boolean;
  contentHash: string;
  capabilityGrants: CapabilityGrant[];
};

const optionalExecutorSchema = skillExecutorConfigSchema.nullable().default(null);
const capabilitySchema = z.enum(skillCapabilityValues);
const capabilityScopeSchema = z.record(z.string(), z.unknown()).default({});
const packageSignatureSchema = z.object({
  algorithm: z.string().trim().min(1).max(80),
  keyId: z.string().trim().min(1).max(160).optional(),
  value: z.string().trim().min(1).max(16_384).optional(),
}).strict();

export const skillManifestInputSchema = z.object({
  slug: z.string().trim().min(2).max(80).regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(""),
  visibility: z.enum(["private", "workspace"]).default("workspace"),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  capabilityRequests: z.array(capabilitySchema).max(skillCapabilityValues.length).optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  executor: optionalExecutorSchema,
});

export const skillVersionInputSchema = z.object({
  description: z.string().trim().max(1000).optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  capabilityRequests: z.array(capabilitySchema).max(skillCapabilityValues.length).optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  promptVersion: z.string().trim().min(1).max(120).nullable().default(null),
  changeNote: z.string().trim().max(500).default(""),
  executor: optionalExecutorSchema,
});

export const skillPackageInputSchema = z.object({
  format: z.literal("atypica.skill/v1"),
  manifest: z.object({
    slug: z.string().trim().min(2).max(80).regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).default(""),
    visibility: z.enum(["private", "workspace"]).default("workspace"),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    requestedCapabilities: z.array(capabilitySchema).max(skillCapabilityValues.length).default([]),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    executor: optionalExecutorSchema,
    changeNote: z.string().trim().max(500).default("Imported .skill package"),
  }).strict(),
  skillMarkdown: z.string().min(1).max(120_000)
    .refine((value) => !value.includes("\0"), "SKILL.md 不能包含空字节")
    .refine((value) => /^#\s+\S/m.test(value), "SKILL.md 必须包含一级标题"),
  signature: packageSignatureSchema.optional(),
}).strict();

export const skillPackageApprovalInputSchema = z.object({
  grants: z.array(z.object({
    capability: capabilitySchema,
    scope: capabilityScopeSchema,
  }).strict()).max(skillCapabilityValues.length),
}).strict();

export const skillActivationInputSchema = z.object({
  source: z.enum(["builtin", "workspace"]),
  slug: z.string().trim().min(2).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  publicId: z.string().trim().min(1).nullable().default(null),
  enabled: z.boolean(),
});

export const skillExecutionInputSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
});

function jsonValue<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

export function hashSkillPackage(value: unknown) {
  return hashJson(canonicalJson(value));
}

function executorStorage(executor: SkillExecutorConfig | null) {
  return { type: executor?.kind ?? "unconfigured", config: executor ?? {} };
}

function normalizedCapabilityRequests(
  requests: SkillCapability[],
  executor: SkillExecutorConfig | null,
) {
  const implied = executor ? requiredExecutorCapabilities(executor) : [];
  return [...new Set([...requests, ...implied])].sort() as SkillCapability[];
}

function signatureMetadata(signature?: z.infer<typeof packageSignatureSchema>) {
  if (!signature) return { verificationState: "not_provided" as const };
  return {
    algorithm: signature.algorithm,
    keyId: signature.keyId ?? null,
    declared: Boolean(signature.value),
    verificationState: "declared_unverified" as const,
  };
}

function versionHash(input: {
  version: number;
  capabilities: string[];
  requestedCapabilities: SkillCapability[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  promptVersion: string | null;
  executor: SkillExecutorConfig | null;
  changeNote?: string;
  packageFormat?: "inline" | "atypica.skill/v1";
  packageContent?: Record<string, unknown>;
  signatureMetadata?: Record<string, unknown>;
}) {
  const executor = executorStorage(input.executor);
  return hashJson({
    version: input.version,
    capabilities: input.capabilities,
    requestedCapabilities: input.requestedCapabilities,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    promptVersion: input.promptVersion,
    executorType: executor.type,
    executorConfig: executor.config,
    changeNote: input.changeNote ?? "",
    packageFormat: input.packageFormat ?? "inline",
    packageContent: input.packageContent ?? {},
    signatureMetadata: input.signatureMetadata ?? { verificationState: "not_applicable" },
  });
}

function packageContent(input: z.infer<typeof skillPackageInputSchema>) {
  const manifest = input.manifest;
  return {
    format: input.format,
    manifest: {
      slug: manifest.slug,
      name: manifest.name,
      description: manifest.description,
      visibility: manifest.visibility,
      capabilities: manifest.capabilities,
      requestedCapabilities: normalizedCapabilityRequests(manifest.requestedCapabilities, manifest.executor),
      inputSchema: manifest.inputSchema,
      outputSchema: manifest.outputSchema,
      executor: manifest.executor,
      changeNote: manifest.changeNote,
    },
    skillMarkdown: input.skillMarkdown.replaceAll("\r\n", "\n"),
    ...(input.signature ? { signature: input.signature } : {}),
  };
}

function canAdministerPackages(viewer: Viewer) {
  return viewer.role === "owner" || viewer.role === "admin";
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

async function listCapabilityGrants(queryable: Queryable, workspaceId: string, skillVersionId: string) {
  const result = await queryable.query<{ capability: SkillCapability; scope: Record<string, unknown> | string }>(
    `select capability, scope from workspace_skill_capability_grants
     where workspace_id = $1 and skill_version_id = $2 order by capability asc`,
    [workspaceId, skillVersionId],
  );
  return result.rows.map((row) => ({ capability: row.capability, scope: jsonValue<Record<string, unknown>>(row.scope) }));
}

function missingCapabilities(requested: SkillCapability[], grants: CapabilityGrant[]) {
  const granted = new Set(grants.map((grant) => grant.capability));
  return requested.filter((capability) => !granted.has(capability));
}

function executionPolicy(config: SkillExecutorConfig, grants: CapabilityGrant[]): SkillExecutionPolicy {
  const networkGrant = grants.find((grant) => grant.capability === "network");
  if (!networkGrant) return {};
  const scopedOrigins = networkGrant.scope.origins;
  if (Array.isArray(scopedOrigins) && scopedOrigins.every((origin) => typeof origin === "string")) {
    return { allowedNetworkOrigins: scopedOrigins.map((origin) => new URL(origin).origin) };
  }
  // Existing immutable grants predate scoped origins. Restrict them to the version's endpoint.
  return { allowedNetworkOrigins: [new URL(config.endpoint).origin] };
}

async function insertCapabilityGrants(input: {
  queryable: Queryable;
  workspaceId: string;
  skillId: string;
  skillVersionId: string;
  actorUserId: string;
  grants: CapabilityGrant[];
}) {
  for (const grant of input.grants) {
    await input.queryable.query(
      `insert into workspace_skill_capability_grants (
         workspace_id, skill_id, skill_version_id, capability, scope, granted_by
       ) values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (workspace_id, skill_version_id, capability) do nothing`,
      [input.workspaceId, input.skillId, input.skillVersionId, grant.capability, JSON.stringify(grant.scope), input.actorUserId],
    );
  }
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
    packageFormat: "inline",
    requestedCapabilities: [],
    grantedCapabilities: [],
    capabilityState: "not_required",
    signatureState: "not_applicable",
    health: null,
  }));
}

export function resolveBuiltInSkill<Skill extends { version: number }>(registry: Record<string, Skill>, slug: string) {
  const skill = registry[slug];
  if (!skill) throw new Error(`SKILL_NOT_FOUND:${slug}`);
  return skill;
}

export async function listWorkspaceSkills(viewer: Viewer): Promise<SkillSummary[]> {
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string;
    slug: string;
    name: string;
    description: string;
    status: SkillLifecycle;
    version_id: string;
    selected_version: number;
    manifest: { capabilities?: string[] } | string;
    executor_type: "unconfigured" | "declarative_http" | "mcp";
    executor_config: Record<string, unknown> | string;
    content_hash: string;
    package_format: "inline" | "atypica.skill/v1";
    requested_capabilities: SkillCapability[] | string;
    signature_metadata: { verificationState?: SkillSummary["signatureState"] } | string;
    enabled: boolean | null;
    health_status: "healthy" | "unhealthy" | null;
    health_created_at: string | null;
  }>(
    `select skill.public_id, skill.slug, skill.name, skill.description, skill.status,
            version.id::text as version_id, version.version as selected_version, version.manifest,
            version.executor_type, version.executor_config, version.content_hash, version.package_format,
            version.requested_capabilities, version.signature_metadata, setting.enabled,
            health.status as health_status, health.created_at::text as health_created_at
     from skill_manifests skill
     left join workspace_skill_settings setting on setting.workspace_id = skill.workspace_id
       and setting.skill_source = 'workspace' and setting.skill_slug = skill.slug and setting.skill_id = skill.id
     join skill_versions version on version.skill_id = skill.id
       and version.version = coalesce(setting.pinned_version, skill.latest_version)
     left join lateral (
       select status, created_at from skill_executor_health_checks
       where skill_id = skill.id and skill_version_id = version.id
       order by created_at desc, id desc limit 1
     ) health on true
     where skill.workspace_id = $1
       and (skill.visibility = 'workspace' or skill.owner_user_id = $2)
     order by skill.updated_at desc, skill.id desc`,
    [viewer.workspaceId, viewer.userId],
  );
  return Promise.all(result.rows.map(async (row) => {
    const manifest = jsonValue<{ capabilities?: string[] }>(row.manifest);
    const requested = jsonValue<SkillCapability[]>(row.requested_capabilities);
    const grants = await listCapabilityGrants(database, viewer.workspaceId, row.version_id);
    const missing = missingCapabilities(requested, grants);
    const signature = jsonValue<{ verificationState?: SkillSummary["signatureState"] }>(row.signature_metadata);
    const executable = row.executor_type !== "unconfigured";
    return {
      publicId: row.public_id,
      slug: row.slug,
      version: row.selected_version,
      name: row.name,
      description: row.description,
      capabilities: manifest.capabilities ?? [],
      source: "workspace" as const,
      status: row.status,
      executable,
      enabled: executable && row.status === "active" && (row.enabled ?? false) && missing.length === 0,
      executorType: row.executor_type,
      contentHash: row.content_hash,
      packageFormat: row.package_format,
      requestedCapabilities: requested,
      grantedCapabilities: grants.map((grant) => grant.capability),
      capabilityState: requested.length === 0 ? "not_required" : missing.length ? "pending" : "granted",
      signatureState: signature.verificationState ?? (row.package_format === "inline" ? "not_applicable" : "not_provided"),
      health: row.health_status && row.health_created_at ? { status: row.health_status, checkedAt: row.health_created_at } : null,
    };
  }));
}

export async function listSkillCatalog(viewer: Viewer, builtins: SkillSummary[]) {
  const database = await getDatabase();
  const [workspaceSkills, settings] = await Promise.all([listWorkspaceSkills(viewer), listSettings(database, viewer.workspaceId)]);
  return [
    ...builtins.map((skill) => ({ ...skill, enabled: settings.get(`builtin:${skill.slug}`)?.enabled ?? true })),
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

export async function createWorkspaceSkill(viewer: Viewer, input: z.infer<typeof skillManifestInputSchema>) {
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
    const requestedCapabilities = normalizedCapabilityRequests(input.capabilityRequests ?? [], input.executor);
    const contentHash = versionHash({
      version: 1, capabilities: input.capabilities, requestedCapabilities, inputSchema: input.inputSchema,
      outputSchema: input.outputSchema, promptVersion: null, executor: input.executor,
    });
    const version = await transaction.query<{ id: string }>(
      `insert into skill_versions (
         public_id, skill_id, version, manifest, input_schema, output_schema, executor_type, executor_config,
         content_hash, package_format, package_content, signature_metadata, requested_capabilities
       ) values ($1, $2, 1, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, 'inline', '{}'::jsonb, $9::jsonb, $10::jsonb)
       returning id::text as id`,
      [
        createPublicId("skv"), skill.id, JSON.stringify({ capabilities: input.capabilities }),
        JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema), executor.type,
        JSON.stringify(executor.config), contentHash, JSON.stringify({ verificationState: "not_applicable" }),
        JSON.stringify(requestedCapabilities),
      ],
    );
    await transaction.query(
      `insert into workspace_skill_settings (
         workspace_id, skill_id, skill_source, skill_slug, enabled, updated_by
       ) values ($1, $2, 'workspace', $3, false, $4)`,
      [viewer.workspaceId, skill.id, input.slug, viewer.userId],
    );
    if (canAdministerPackages(viewer)) {
      await insertCapabilityGrants({
        queryable: transaction, workspaceId: viewer.workspaceId, skillId: skill.id, skillVersionId: version.rows[0].id,
        actorUserId: viewer.userId, grants: requestedCapabilities.map((capability) => ({ capability, scope: {} })),
      });
    }
    await transaction.query(
      `insert into skill_events (skill_id, workspace_id, actor_user_id, event_type, payload)
       values ($1, $2, $3, 'skill.created', $4::jsonb)`,
      [skill.id, viewer.workspaceId, viewer.userId, JSON.stringify({ version: 1, executorType: executor.type, contentHash, requestedCapabilities })],
    );
    return { publicId: skill.public_id, version: 1, contentHash };
  });
}

export async function importWorkspaceSkillPackage(viewer: Viewer, input: z.infer<typeof skillPackageInputSchema>) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const content = packageContent(input);
  const manifest = content.manifest;
  const executor = executorStorage(manifest.executor);
  const requestedCapabilities = manifest.requestedCapabilities;
  const signature = signatureMetadata(input.signature);
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const inserted = await transaction.query<{ id: string; public_id: string }>(
      `insert into skill_manifests (
         public_id, workspace_id, owner_user_id, slug, name, description, visibility, status
       ) values ($1, $2, $3, $4, $5, $6, $7, 'submitted')
       on conflict (workspace_id, slug) do nothing
       returning id::text as id, public_id`,
      [createPublicId("skl"), viewer.workspaceId, viewer.userId, manifest.slug, manifest.name, manifest.description, manifest.visibility],
    );
    const skill = inserted.rows[0];
    if (!skill) return "conflict" as const;
    const contentHash = versionHash({
      version: 1, capabilities: manifest.capabilities, requestedCapabilities, inputSchema: manifest.inputSchema,
      outputSchema: manifest.outputSchema, promptVersion: null, executor: manifest.executor, changeNote: manifest.changeNote,
      packageFormat: "atypica.skill/v1", packageContent: content, signatureMetadata: signature,
    });
    await transaction.query(
      `insert into skill_versions (
         public_id, skill_id, version, manifest, input_schema, output_schema, executor_type, executor_config,
         content_hash, package_format, package_content, signature_metadata, requested_capabilities
       ) values ($1, $2, 1, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, 'atypica.skill/v1', $9::jsonb, $10::jsonb, $11::jsonb)`,
      [
        createPublicId("skv"), skill.id,
        JSON.stringify({ capabilities: manifest.capabilities, changeNote: manifest.changeNote, packageHash: hashSkillPackage(content) }),
        JSON.stringify(manifest.inputSchema), JSON.stringify(manifest.outputSchema), executor.type,
        JSON.stringify(executor.config), contentHash, JSON.stringify(content), JSON.stringify(signature), JSON.stringify(requestedCapabilities),
      ],
    );
    await transaction.query(
      `insert into workspace_skill_settings (
         workspace_id, skill_id, skill_source, skill_slug, enabled, updated_by
       ) values ($1, $2, 'workspace', $3, false, $4)`,
      [viewer.workspaceId, skill.id, manifest.slug, viewer.userId],
    );
    const payload = { version: 1, contentHash, packageHash: hashSkillPackage(content), requestedCapabilities, signature };
    await transaction.query(
      `insert into skill_events (skill_id, workspace_id, actor_user_id, event_type, payload)
       values ($1, $2, $3, 'skill.package.imported', $4::jsonb)`,
      [skill.id, viewer.workspaceId, viewer.userId, JSON.stringify(payload)],
    );
    await transaction.query(
      `insert into skill_control_events (workspace_id, skill_id, actor_user_id, skill_source, skill_slug, event_type, payload)
       values ($1, $2, $3, 'workspace', $4, 'skill.package.imported', $5::jsonb)`,
      [viewer.workspaceId, skill.id, viewer.userId, manifest.slug, JSON.stringify(payload)],
    );
    return { publicId: skill.public_id, version: 1, contentHash, packageHash: hashSkillPackage(content) };
  });
}

export async function approveWorkspaceSkillPackage(
  viewer: Viewer,
  publicId: string,
  input: z.infer<typeof skillPackageApprovalInputSchema>,
) {
  if (!canAdministerPackages(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      id: string; slug: string; status: SkillLifecycle; version_id: string; requested_capabilities: SkillCapability[] | string;
    }>(
      `select skill.id::text as id, skill.slug, skill.status, version.id::text as version_id, version.requested_capabilities
       from skill_manifests skill join skill_versions version on version.skill_id = skill.id and version.version = skill.latest_version
       where skill.workspace_id = $1 and skill.public_id = $2 for update of skill`,
      [viewer.workspaceId, publicId],
    );
    const skill = result.rows[0];
    if (!skill) return "not_found" as const;
    if (skill.status === "revoked" || skill.status === "archived") return skill.status;
    const requested = jsonValue<SkillCapability[]>(skill.requested_capabilities);
    const supplied = new Map(input.grants.map((grant) => [grant.capability, grant]));
    const missing = requested.filter((capability) => !supplied.has(capability));
    const unexpected = input.grants.filter((grant) => !requested.includes(grant.capability));
    if (missing.length || unexpected.length) return { error: "capability_mismatch" as const, missing, unexpected: unexpected.map((grant) => grant.capability) };
    await insertCapabilityGrants({
      queryable: transaction, workspaceId: viewer.workspaceId, skillId: skill.id, skillVersionId: skill.version_id,
      actorUserId: viewer.userId, grants: input.grants,
    });
    await transaction.query("update skill_manifests set status = 'active', updated_at = now() where id = $1", [skill.id]);
    await transaction.query(
      `insert into skill_control_events (workspace_id, skill_id, actor_user_id, skill_source, skill_slug, event_type, payload)
       values ($1, $2, $3, 'workspace', $4, 'skill.package.approved', $5::jsonb)`,
      [viewer.workspaceId, skill.id, viewer.userId, skill.slug, JSON.stringify({ versionId: skill.version_id, grants: input.grants })],
    );
    return { status: "active" as const, grantedCapabilities: requested };
  });
}

export async function revokeWorkspaceSkill(viewer: Viewer, publicId: string) {
  if (!canAdministerPackages(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; slug: string; status: SkillLifecycle }>(
      `select id::text as id, slug, status from skill_manifests
       where workspace_id = $1 and public_id = $2 for update`,
      [viewer.workspaceId, publicId],
    );
    const skill = result.rows[0];
    if (!skill) return "not_found" as const;
    if (skill.status === "archived") return "archived" as const;
    await transaction.query("update skill_manifests set status = 'revoked', updated_at = now() where id = $1", [skill.id]);
    await transaction.query(
      `update workspace_skill_settings set enabled = false, updated_by = $3, updated_at = now()
       where workspace_id = $1 and skill_id = $2`,
      [viewer.workspaceId, skill.id, viewer.userId],
    );
    await transaction.query(
      `insert into skill_control_events (workspace_id, skill_id, actor_user_id, skill_source, skill_slug, event_type, payload)
       values ($1, $2, $3, 'workspace', $4, 'skill.revoked', '{}'::jsonb)`,
      [viewer.workspaceId, skill.id, viewer.userId, skill.slug],
    );
    return { status: "revoked" as const };
  });
}

export async function exportWorkspaceSkillPackage(viewer: Viewer, publicId: string) {
  const database = await getDatabase();
  const result = await database.query<{ package_content: z.infer<typeof skillPackageInputSchema> | string }>(
    `select version.package_content from skill_manifests skill
     join skill_versions version on version.skill_id = skill.id and version.version = skill.latest_version
     where skill.workspace_id = $1 and skill.public_id = $2 and skill.status = 'active'
       and (skill.visibility = 'workspace' or skill.owner_user_id = $3)
       and version.package_format = 'atypica.skill/v1' limit 1`,
    [viewer.workspaceId, publicId, viewer.userId],
  );
  const row = result.rows[0];
  if (!row) return "not_found" as const;
  const parsed = skillPackageInputSchema.safeParse(jsonValue(row.package_content));
  if (!parsed.success) return "invalid_package" as const;
  return packageContent(parsed.data);
}

export async function publishWorkspaceSkillVersion(viewer: Viewer, publicId: string, input: z.infer<typeof skillVersionInputSchema>) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      id: string; latest_version: number; owner_user_id: string; requested_capabilities: SkillCapability[] | string;
    }>(
      `select skill.id::text as id, skill.latest_version, skill.owner_user_id::text as owner_user_id,
              previous.requested_capabilities
       from skill_manifests skill
       join skill_versions previous on previous.skill_id = skill.id and previous.version = skill.latest_version
       where skill.public_id = $1 and skill.workspace_id = $2 for update of skill`,
      [publicId, viewer.workspaceId],
    );
    const skill = result.rows[0];
    if (!skill) return "not_found" as const;
    if (viewer.role === "member" && skill.owner_user_id !== viewer.userId) return "forbidden" as const;
    const version = skill.latest_version + 1;
    const executor = executorStorage(input.executor);
    const requestedCapabilities = normalizedCapabilityRequests(
      input.capabilityRequests ?? jsonValue<SkillCapability[]>(skill.requested_capabilities), input.executor,
    );
    const contentHash = versionHash({
      version, capabilities: input.capabilities, requestedCapabilities, inputSchema: input.inputSchema,
      outputSchema: input.outputSchema, promptVersion: input.promptVersion, executor: input.executor, changeNote: input.changeNote,
    });
    const insertedVersion = await transaction.query<{ id: string }>(
      `insert into skill_versions (
         public_id, skill_id, version, manifest, input_schema, output_schema, prompt_version,
         executor_type, executor_config, content_hash, package_format, package_content, signature_metadata, requested_capabilities
       ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, $10, 'inline', '{}'::jsonb, $11::jsonb, $12::jsonb)
       returning id::text as id`,
      [
        createPublicId("skv"), skill.id, version, JSON.stringify({ capabilities: input.capabilities, changeNote: input.changeNote }),
        JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema), input.promptVersion, executor.type,
        JSON.stringify(executor.config), contentHash, JSON.stringify({ verificationState: "not_applicable" }), JSON.stringify(requestedCapabilities),
      ],
    );
    if (canAdministerPackages(viewer)) {
      await insertCapabilityGrants({
        queryable: transaction, workspaceId: viewer.workspaceId, skillId: skill.id, skillVersionId: insertedVersion.rows[0].id,
        actorUserId: viewer.userId, grants: requestedCapabilities.map((capability) => ({ capability, scope: {} })),
      });
    }
    await transaction.query(
      `update skill_manifests set latest_version = $2, description = coalesce($3, description), updated_at = now() where id = $1`,
      [skill.id, version, input.description ?? null],
    );
    await transaction.query(
      `insert into skill_events (skill_id, workspace_id, actor_user_id, event_type, payload)
       values ($1, $2, $3, 'skill.version.published', $4::jsonb)`,
      [skill.id, viewer.workspaceId, viewer.userId, JSON.stringify({ version, changeNote: input.changeNote, executorType: executor.type, contentHash, requestedCapabilities })],
    );
    return { publicId, version, contentHash };
  });
}

export async function setWorkspaceSkillEnabled(viewer: Viewer, input: z.infer<typeof skillActivationInputSchema>) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    let skillId: string | null = null;
    let pinnedVersion: number | null = null;
    if (input.source === "builtin") {
      if (!canAdministerPackages(viewer)) return "forbidden" as const;
    } else {
      const result = await transaction.query<{
        id: string; owner_user_id: string; latest_version: number; status: SkillLifecycle; version_id: string;
        executor_type: "unconfigured" | "declarative_http" | "mcp"; executor_config: Record<string, unknown> | string;
        requested_capabilities: SkillCapability[] | string;
      }>(
        `select skill.id::text as id, skill.owner_user_id::text as owner_user_id, skill.latest_version, skill.status,
                version.id::text as version_id, version.executor_type, version.executor_config, version.requested_capabilities
         from skill_manifests skill join skill_versions version on version.skill_id = skill.id and version.version = skill.latest_version
         where skill.workspace_id = $1 and skill.public_id = $2 and skill.slug = $3 for update of skill`,
        [viewer.workspaceId, input.publicId, input.slug],
      );
      const skill = result.rows[0];
      if (!skill) return "not_found" as const;
      if (viewer.role === "member" && skill.owner_user_id !== viewer.userId) return "forbidden" as const;
      if (input.enabled && skill.executor_type === "unconfigured") return "unconfigured" as const;
      if (input.enabled && skill.status === "archived") return "archived" as const;
      if (input.enabled && skill.status === "revoked") return "revoked" as const;
      if (input.enabled && skill.status === "submitted") return "pending_approval" as const;
      if (input.enabled) {
        const parsedConfig = skillExecutorConfigSchema.safeParse(jsonValue(skill.executor_config));
        if (!parsedConfig.success || parsedConfig.data.kind !== skill.executor_type) return "unconfigured" as const;
        const requested = normalizedCapabilityRequests(jsonValue<SkillCapability[]>(skill.requested_capabilities), parsedConfig.data);
        const grants = await listCapabilityGrants(transaction, viewer.workspaceId, skill.version_id);
        const missing = missingCapabilities(requested, grants);
        if (missing.length) return { error: "capability_denied" as const, missing };
      }
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
         skill_id = excluded.skill_id, enabled = excluded.enabled, pinned_version = excluded.pinned_version,
         updated_by = excluded.updated_by, updated_at = now()`,
      [viewer.workspaceId, skillId, input.source, input.slug, input.enabled, pinnedVersion, viewer.userId],
    );
    await transaction.query(
      `insert into skill_control_events (
         workspace_id, skill_id, actor_user_id, skill_source, skill_slug, event_type, payload
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [viewer.workspaceId, skillId, viewer.userId, input.source, input.slug, input.enabled ? "skill.enabled" : "skill.disabled", JSON.stringify({ enabled: input.enabled, pinnedVersion })],
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
    const capabilityGrants: CapabilityGrant[] = [];
    const contentHash = hashJson({ source: "builtin", slug: skill.slug, version: skill.version, executorType: "builtin", capabilityGrants });
    await input.queryable.query(
      `insert into study_run_skill_bindings (
         public_id, workspace_id, study_id, run_id, skill_source, skill_slug, skill_version,
         executor_type, executor_config, input_schema, output_schema, content_hash, enabled_at_lock, capability_grants
       ) values ($1, $2, $3, $4, 'builtin', $5, $6, 'builtin', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $7, $8, $9::jsonb)
       on conflict (run_id, skill_slug) do nothing`,
      [createPublicId("skb"), input.workspaceId, input.studyId, input.runId, skill.slug, skill.version, contentHash, enabled, JSON.stringify(capabilityGrants)],
    );
  }
}

export async function lockRunWorkspaceSkill(input: {
  queryable: Queryable;
  workspaceId: string;
  studyId: string;
  runId: string;
  publicId: string;
}) {
  const result = await input.queryable.query<{
    skill_id: string; public_id: string; slug: string; version_id: string; version: number; status: SkillLifecycle; enabled: boolean | null;
    executor_type: "unconfigured" | "declarative_http" | "mcp"; executor_config: Record<string, unknown> | string;
    input_schema: Record<string, unknown> | string; output_schema: Record<string, unknown> | string; content_hash: string;
    requested_capabilities: SkillCapability[] | string;
  }>(
    `select skill.id::text as skill_id, skill.public_id, skill.slug, version.id::text as version_id, version.version, skill.status,
            setting.enabled, version.executor_type, version.executor_config, version.input_schema, version.output_schema,
            version.content_hash, version.requested_capabilities
     from skill_manifests skill
     join workspace_skill_settings setting on setting.workspace_id = skill.workspace_id and setting.skill_id = skill.id
     join skill_versions version on version.skill_id = skill.id and version.version = coalesce(setting.pinned_version, skill.latest_version)
     where skill.workspace_id = $1 and skill.public_id = $2 limit 1`,
    [input.workspaceId, input.publicId],
  );
  const skill = result.rows[0];
  if (!skill || skill.status !== "active") return "not_found" as const;
  if (!skill.enabled || skill.executor_type === "unconfigured") return "disabled" as const;
  const config = skillExecutorConfigSchema.safeParse(jsonValue(skill.executor_config));
  if (!config.success || config.data.kind !== skill.executor_type) return "disabled" as const;
  const grants = await listCapabilityGrants(input.queryable, input.workspaceId, skill.version_id);
  const requested = normalizedCapabilityRequests(jsonValue<SkillCapability[]>(skill.requested_capabilities), config.data);
  if (missingCapabilities(requested, grants).length) return "capability_denied" as const;
  await input.queryable.query(
    `insert into study_run_skill_bindings (
       public_id, workspace_id, study_id, run_id, skill_id, skill_source, skill_slug, skill_version,
       executor_type, executor_config, input_schema, output_schema, content_hash, enabled_at_lock, capability_grants
     ) values ($1, $2, $3, $4, $5, 'workspace', $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, true, $13::jsonb)
     on conflict (run_id, skill_slug) do nothing`,
    [
      createPublicId("skb"), input.workspaceId, input.studyId, input.runId, skill.skill_id, skill.slug, skill.version,
      skill.executor_type, JSON.stringify(jsonValue(skill.executor_config)), JSON.stringify(jsonValue(skill.input_schema)),
      JSON.stringify(jsonValue(skill.output_schema)), skill.content_hash, JSON.stringify(grants),
    ],
  );
  return { publicId: skill.public_id, slug: skill.slug, version: skill.version, grants };
}

export async function getRunSkillBinding(runId: string, slug: string): Promise<RunSkillBinding | null> {
  const database = await getDatabase();
  const result = await database.query<{
    id: string; public_id: string; skill_slug: string; skill_version: number;
    executor_type: RunSkillBinding["executorType"]; enabled_at_lock: boolean; content_hash: string;
    capability_grants: CapabilityGrant[] | string;
  }>(
    `select id::text as id, public_id, skill_slug, skill_version, executor_type, enabled_at_lock, content_hash, capability_grants
     from study_run_skill_bindings where run_id = $1 and skill_slug = $2 limit 1`,
    [runId, slug],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id, publicId: row.public_id, slug: row.skill_slug, version: row.skill_version,
    executorType: row.executor_type, enabledAtLock: row.enabled_at_lock, contentHash: row.content_hash,
    capabilityGrants: jsonValue<CapabilityGrant[]>(row.capability_grants),
  } : null;
}

export async function executeWorkspaceSkill(viewer: Viewer, publicId: string, argumentsInput: Record<string, unknown>) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{
    skill_id: string; skill_version_id: string; enabled: boolean | null; version: number;
    executor_type: "unconfigured" | "declarative_http" | "mcp"; executor_config: Record<string, unknown> | string;
    input_schema: Record<string, unknown> | string; output_schema: Record<string, unknown> | string;
    requested_capabilities: SkillCapability[] | string;
  }>(
    `select skill.id::text as skill_id, version.id::text as skill_version_id, setting.enabled, version.version,
            version.executor_type, version.executor_config, version.input_schema, version.output_schema, version.requested_capabilities
     from skill_manifests skill
     join workspace_skill_settings setting on setting.workspace_id = skill.workspace_id
       and setting.skill_source = 'workspace' and setting.skill_slug = skill.slug and setting.skill_id = skill.id
     join skill_versions version on version.skill_id = skill.id and version.version = coalesce(setting.pinned_version, skill.latest_version)
     where skill.public_id = $1 and skill.workspace_id = $2 and skill.status = 'active'
       and (skill.visibility = 'workspace' or skill.owner_user_id = $3) limit 1`,
    [publicId, viewer.workspaceId, viewer.userId],
  );
  const skill = result.rows[0];
  if (!skill) return "not_found" as const;
  if (!skill.enabled) return "disabled" as const;
  if (skill.executor_type === "unconfigured") return "unconfigured" as const;
  const config = skillExecutorConfigSchema.safeParse(jsonValue(skill.executor_config));
  if (!config.success || config.data.kind !== skill.executor_type) return "unconfigured" as const;
  const requested = normalizedCapabilityRequests(jsonValue<SkillCapability[]>(skill.requested_capabilities), config.data);
  const grants = await listCapabilityGrants(database, viewer.workspaceId, skill.skill_version_id);
  const missing = missingCapabilities(requested, grants);
  if (missing.length) return { error: "capability_denied" as const, missing };
  const inputSchema = jsonValue<Record<string, unknown>>(skill.input_schema);
  const outputSchema = jsonValue<Record<string, unknown>>(skill.output_schema);
  const requestHash = hashJson(argumentsInput);
  const execution = await database.query<{ id: string; public_id: string }>(
    `insert into skill_executions (
       public_id, workspace_id, skill_id, skill_version_id, actor_user_id, executor_type, input, request_hash
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) returning id::text as id, public_id`,
    [createPublicId("ske"), viewer.workspaceId, skill.skill_id, skill.skill_version_id, viewer.userId, skill.executor_type, JSON.stringify(argumentsInput), requestHash],
  );
  const executionRow = execution.rows[0];
  try {
    const output = await executeConfiguredSkill({
      config: config.data,
      inputSchema,
      outputSchema,
      arguments: argumentsInput,
      policy: executionPolicy(config.data, grants),
    });
    const responseHash = hashJson(output);
    await database.query(
      `update skill_executions set status = 'completed', output = $2::jsonb, response_hash = $3, finished_at = now() where id = $1`,
      [executionRow.id, JSON.stringify(output), responseHash],
    );
    return { publicId: executionRow.public_id, version: skill.version, output, requestHash, responseHash };
  } catch (error) {
    const code = error instanceof SkillExecutionError ? error.code : "SKILL_EXECUTION_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 1_000) : "Skill execution failed";
    await database.query(
      `update skill_executions set status = 'failed', error_code = $2, error_message = $3, finished_at = now() where id = $1`,
      [executionRow.id, code, message],
    );
    throw error;
  }
}

export async function probeWorkspaceSkill(viewer: Viewer, publicId: string) {
  if (!canAdministerPackages(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{
    skill_id: string; version_id: string; slug: string; status: SkillLifecycle;
    executor_type: "unconfigured" | "declarative_http" | "mcp"; executor_config: Record<string, unknown> | string;
    requested_capabilities: SkillCapability[] | string;
  }>(
    `select skill.id::text as skill_id, version.id::text as version_id, skill.slug, skill.status,
            version.executor_type, version.executor_config, version.requested_capabilities
     from skill_manifests skill join skill_versions version on version.skill_id = skill.id and version.version = skill.latest_version
     where skill.workspace_id = $1 and skill.public_id = $2 limit 1`,
    [viewer.workspaceId, publicId],
  );
  const skill = result.rows[0];
  if (!skill) return "not_found" as const;
  if (skill.status === "revoked" || skill.status === "archived") return skill.status;
  if (skill.executor_type === "unconfigured") return "unconfigured" as const;
  const config = skillExecutorConfigSchema.safeParse(jsonValue(skill.executor_config));
  if (!config.success || config.data.kind !== skill.executor_type) return "unconfigured" as const;
  const requested = normalizedCapabilityRequests(jsonValue<SkillCapability[]>(skill.requested_capabilities), config.data);
  const grants = await listCapabilityGrants(database, viewer.workspaceId, skill.version_id);
  const missing = missingCapabilities(requested, grants);
  if (missing.length) return { error: "capability_denied" as const, missing };
  try {
    const probe = await probeConfiguredSkill(config.data, executionPolicy(config.data, grants));
    await database.query(
      `insert into skill_executor_health_checks (
         public_id, workspace_id, skill_id, skill_version_id, actor_user_id, executor_type, status, latency_ms, detail
       ) values ($1, $2, $3, $4, $5, $6, 'healthy', $7, $8)`,
      [createPublicId("skh"), viewer.workspaceId, skill.skill_id, skill.version_id, viewer.userId, skill.executor_type, probe.latencyMs, probe.detail],
    );
    await database.query(
      `insert into skill_control_events (workspace_id, skill_id, actor_user_id, skill_source, skill_slug, event_type, payload)
       values ($1, $2, $3, 'workspace', $4, 'skill.health.checked', $5::jsonb)`,
      [viewer.workspaceId, skill.skill_id, viewer.userId, skill.slug, JSON.stringify({ status: "healthy", latencyMs: probe.latencyMs })],
    );
    return { status: "healthy" as const, latencyMs: probe.latencyMs };
  } catch (error) {
    const code = error instanceof SkillExecutionError ? error.code : "SKILL_HEALTH_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 500) : "Skill health probe failed";
    await database.query(
      `insert into skill_executor_health_checks (
         public_id, workspace_id, skill_id, skill_version_id, actor_user_id, executor_type, status, error_code, detail
       ) values ($1, $2, $3, $4, $5, $6, 'unhealthy', $7, $8)`,
      [createPublicId("skh"), viewer.workspaceId, skill.skill_id, skill.version_id, viewer.userId, skill.executor_type, code, message],
    );
    return { status: "unhealthy" as const, code };
  }
}
