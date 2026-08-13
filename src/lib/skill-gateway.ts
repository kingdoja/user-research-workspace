import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

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
};

export const skillManifestInputSchema = z.object({
  slug: z.string().trim().min(2).max(80).regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(""),
  visibility: z.enum(["private", "workspace"]).default("workspace"),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
});

export const skillVersionInputSchema = z.object({
  description: z.string().trim().max(1000).optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  promptVersion: z.string().trim().min(1).max(120).nullable().default(null),
  changeNote: z.string().trim().max(500).default(""),
});

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

export async function listWorkspaceSkills(viewer: Viewer): Promise<SkillSummary[]> {
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string;
    slug: string;
    name: string;
    description: string;
    status: "active" | "draft" | "archived";
    latest_version: number;
    manifest: { capabilities?: string[] } | string;
  }>(
    `select skill.public_id, skill.slug, skill.name, skill.description, skill.status,
            skill.latest_version, version.manifest
     from skill_manifests skill
     join skill_versions version on version.skill_id = skill.id and version.version = skill.latest_version
     where skill.workspace_id = $1
       and (skill.visibility = 'workspace' or skill.owner_user_id = $2)
     order by skill.updated_at desc, skill.id desc`,
    [viewer.workspaceId, viewer.userId],
  );
  return result.rows.map((row) => {
    const manifest = typeof row.manifest === "string" ? JSON.parse(row.manifest) as { capabilities?: string[] } : row.manifest;
    return {
      publicId: row.public_id,
      slug: row.slug,
      version: row.latest_version,
      name: row.name,
      description: row.description,
      capabilities: manifest.capabilities ?? [],
      source: "workspace" as const,
      status: row.status,
      executable: false,
    };
  });
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
    await transaction.query(
      `insert into skill_versions (
         public_id, skill_id, version, manifest, input_schema, output_schema
       ) values ($1, $2, 1, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        createPublicId("skv"), skill.id,
        JSON.stringify({ capabilities: input.capabilities, executor: "declarative_unconfigured" }),
        JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema),
      ],
    );
    await transaction.query(
      `insert into skill_events (skill_id, workspace_id, actor_user_id, event_type, payload)
       values ($1, $2, $3, 'skill.created', $4::jsonb)`,
      [skill.id, viewer.workspaceId, viewer.userId, JSON.stringify({ version: 1 })],
    );
    return { publicId: skill.public_id, version: 1 };
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
    await transaction.query(
      `insert into skill_versions (
         public_id, skill_id, version, manifest, input_schema, output_schema, prompt_version
       ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
      [
        createPublicId("skv"), skill.id, version,
        JSON.stringify({ capabilities: input.capabilities, executor: "declarative_unconfigured", changeNote: input.changeNote }),
        JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema), input.promptVersion,
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
      [skill.id, viewer.workspaceId, viewer.userId, JSON.stringify({ version, changeNote: input.changeNote })],
    );
    return { publicId, version };
  });
}
