import { createHash } from "node:crypto";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { ProviderStage, ProviderRouteOverride } from "@/lib/openai-provider";

export type PublicationArtifactType = "study" | "report" | "context" | "skill";
export type PublicationStatus = "draft" | "submitted" | "accepted" | "rejected" | "revoked";
export type DelegationStatus = "proposed" | "accepted" | "in_progress" | "completed" | "rejected" | "cancelled";
export type QualityTier = "basic" | "standard" | "high" | "premium";

export type CollaborationPublication = {
  publicId: string;
  direction: "outgoing" | "incoming";
  publisherWorkspace: { publicId: string; name: string };
  recipientWorkspace: { publicId: string; name: string };
  artifactType: PublicationArtifactType;
  artifactPublicId: string;
  artifactVersionPublicId: string | null;
  artifactHash: string;
  title: string;
  summary: string;
  capabilities: string[];
  status: PublicationStatus;
  governanceStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CollaborationDelegation = {
  publicId: string;
  direction: "outgoing" | "incoming";
  publicationPublicId: string | null;
  senderWorkspace: { publicId: string; name: string };
  recipientWorkspace: { publicId: string; name: string };
  assignedTo: string | null;
  title: string;
  instructions: string;
  dueAt: string | null;
  status: DelegationStatus;
  createdAt: string;
  updatedAt: string;
};

export type RoutingPolicySummary = {
  publicId: string;
  policyKey: string;
  name: string;
  stage: ProviderStage;
  description: string;
  versions: Array<{
    publicId: string;
    version: number;
    status: "draft" | "active" | "retired";
    selectionMode: "weighted" | "priority";
    maxEstimatedCostMicros: number | null;
    maxLatencyMs: number | null;
    minimumQualityTier: QualityTier;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    changeNote: string;
    routes: Array<{
      routeKey: string;
      providerName: string;
      model: string;
      protocol: "responses" | "chat_completions";
      priority: number;
      weight: number;
      qualityTier: QualityTier;
      expectedLatencyMs: number | null;
      inputPriceMicrosPerMillion: number;
      outputPriceMicrosPerMillion: number;
      pricingSource: string;
      pricingEffectiveAt: string;
      enabled: boolean;
    }>;
  }>;
};

export type RouteDecisionSummary = {
  publicId: string;
  runPublicId: string;
  studyPublicId: string | null;
  runtimeKind: "study" | "agent";
  stage: ProviderStage;
  providerName: string;
  model: string;
  selectionReason: string;
  estimatedCostMicros: number;
  actualCostMicros: number | null;
  latencyMs: number | null;
  qualityScore: number | null;
  status: "selected" | "completed" | "failed";
  createdAt: string;
};

function canManage(viewer: Viewer) {
  return viewer.role === "owner" || viewer.role === "admin";
}

function parsedJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function hashSnapshot(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function snapshotArtifact(
  queryable: Queryable,
  workspaceId: string,
  artifactType: PublicationArtifactType,
  artifactPublicId: string,
) {
  if (artifactType === "report") {
    const result = await queryable.query<{
      public_id: string; title: string; description: string; content_json: unknown; generated_at: string;
      study_public_id: string; study_title: string;
    }>(
      `select report.public_id, report.title, report.description, report.content_json,
              report.generated_at::text as generated_at, study.public_id as study_public_id,
              study.title as study_title
       from reports report join studies study on study.id = report.study_id
       where report.public_id = $1 and study.workspace_id = $2 limit 1`,
      [artifactPublicId, workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const snapshot = {
      format: "atypica.publication/report-v1", publicId: row.public_id, title: row.title,
      description: row.description, content: parsedJson(row.content_json), generatedAt: row.generated_at,
      study: { publicId: row.study_public_id, title: row.study_title },
    };
    return { title: row.title, summary: row.description, versionPublicId: null, snapshot, hash: hashSnapshot(snapshot) };
  }
  if (artifactType === "study") {
    const result = await queryable.query<{
      public_id: string; title: string; brief: string; study_type: string; product_line: string;
      plan_public_id: string | null; plan_content_hash: string | null; plan_snapshot: unknown;
    }>(
      `select study.public_id, study.title, study.brief, study.study_type, study.product_line,
              version.public_id as plan_public_id, version.content_hash as plan_content_hash,
              case when version.id is null then null else jsonb_build_object(
                'schemaVersion', version.schema_version, 'version', version.version,
                'lifecycleStatus', version.lifecycle_status, 'brief', version.brief_snapshot,
                'studyType', version.study_type, 'framework', version.framework,
                'methods', version.methods, 'personaFilters', version.persona_filters,
                'personaCount', version.persona_count, 'estimatedDurationMinutes', version.estimated_duration_minutes,
                'estimatedTokens', version.estimated_tokens, 'source', version.source,
                'providerModel', version.provider_model, 'promptVersion', version.prompt_version,
                'rationale', version.rationale, 'contentHash', version.content_hash
              ) end as plan_snapshot
       from studies study
       left join study_plans plan on plan.study_id = study.id
       left join study_plan_versions version on version.id = plan.current_plan_version_id
       where study.public_id = $1 and study.workspace_id = $2 limit 1`,
      [artifactPublicId, workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const snapshot = {
      format: "atypica.publication/study-v1", publicId: row.public_id, title: row.title,
      brief: row.brief, studyType: row.study_type, productLine: row.product_line,
      plan: row.plan_snapshot ? parsedJson(row.plan_snapshot) : null,
    };
    return {
      title: row.title, summary: row.brief, versionPublicId: row.plan_public_id,
      snapshot, hash: row.plan_content_hash ?? hashSnapshot(snapshot),
    };
  }
  if (artifactType === "context") {
    const result = await queryable.query<{
      public_id: string; title: string; description: string; asset_type: string; scope: string;
      version_public_id: string; version: number; content: unknown; content_hash: string;
    }>(
      `select asset.public_id, asset.title, asset.description, asset.asset_type, asset.scope,
              version.public_id as version_public_id, version.version, version.content, version.content_hash
       from context_assets asset join context_asset_versions version
         on version.asset_id = asset.id and version.version = asset.current_version
       where asset.public_id = $1 and asset.workspace_id = $2 limit 1`,
      [artifactPublicId, workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const snapshot = {
      format: "atypica.publication/context-v1", publicId: row.public_id, title: row.title,
      description: row.description, assetType: row.asset_type, sourceScope: row.scope,
      version: { publicId: row.version_public_id, version: row.version, content: parsedJson(row.content), contentHash: row.content_hash },
    };
    return {
      title: row.title, summary: row.description, versionPublicId: row.version_public_id,
      snapshot, hash: row.content_hash,
    };
  }
  const result = await queryable.query<{
    public_id: string; name: string; description: string; slug: string; version_public_id: string;
    version: number; content_hash: string; manifest: unknown; input_schema: unknown; output_schema: unknown;
    requested_capabilities: unknown;
  }>(
    `select skill.public_id, skill.name, skill.description, skill.slug,
            version.public_id as version_public_id, version.version, version.content_hash,
            version.manifest, version.input_schema, version.output_schema, version.requested_capabilities
     from skill_manifests skill join skill_versions version
       on version.skill_id = skill.id and version.version = skill.latest_version
     where skill.public_id = $1 and skill.workspace_id = $2 and skill.status = 'active' limit 1`,
    [artifactPublicId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const snapshot = {
    format: "atypica.publication/skill-v1", publicId: row.public_id, slug: row.slug,
    name: row.name, description: row.description,
    version: {
      publicId: row.version_public_id, version: row.version, contentHash: row.content_hash,
      manifest: parsedJson(row.manifest), inputSchema: parsedJson(row.input_schema),
      outputSchema: parsedJson(row.output_schema), requestedCapabilities: parsedJson(row.requested_capabilities),
    },
  };
  return {
    title: row.name, summary: row.description, versionPublicId: row.version_public_id,
    snapshot, hash: row.content_hash,
  };
}

export async function createCollaborationPublication(viewer: Viewer, input: {
  recipientWorkspacePublicId: string;
  artifactType: PublicationArtifactType;
  artifactPublicId: string;
  title?: string;
  summary?: string;
  capabilities: Array<"view" | "import" | "delegate">;
}) {
  if (!canManage(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const recipient = await transaction.query<{ id: string }>(
      "select id::text as id from workspaces where public_id = $1 and id <> $2 limit 1",
      [input.recipientWorkspacePublicId, viewer.workspaceId],
    );
    if (!recipient.rows[0]) return "recipient_not_found" as const;
    const artifact = await snapshotArtifact(transaction, viewer.workspaceId, input.artifactType, input.artifactPublicId);
    if (!artifact) return "artifact_not_found" as const;
    const capabilities = [...new Set(["view", ...input.capabilities])];
    const inserted = await transaction.query<{ id: string; public_id: string }>(
      `insert into collaboration_publications (
         public_id, publisher_workspace_id, recipient_workspace_id, created_by,
         artifact_type, artifact_public_id, artifact_version_public_id, artifact_hash,
         title, summary, snapshot, capabilities
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       returning id::text as id, public_id`,
      [
        createPublicId("pub"), viewer.workspaceId, recipient.rows[0].id, viewer.userId,
        input.artifactType, input.artifactPublicId, artifact.versionPublicId, artifact.hash,
        input.title?.trim() || artifact.title, input.summary?.trim() || artifact.summary,
        JSON.stringify(artifact.snapshot), capabilities,
      ],
    );
    await transaction.query(
      `insert into collaboration_events (public_id, publication_id, actor_workspace_id, actor_user_id, event_type)
       values ($1, $2, $3, $4, 'publication.created')`,
      [createPublicId("cev"), inserted.rows[0].id, viewer.workspaceId, viewer.userId],
    );
    return { publicId: inserted.rows[0].public_id, status: "draft" as const };
  });
}

export async function updateCollaborationPublicationStatus(
  viewer: Viewer,
  publicId: string,
  status: "submitted" | "accepted" | "rejected" | "revoked",
) {
  if (!canManage(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      id: string; publisher_workspace_id: string; recipient_workspace_id: string;
      current_status: PublicationStatus; capabilities: string[]; artifact_type: string;
      artifact_public_id: string; artifact_version_public_id: string | null; artifact_hash: string;
    }>(
      `select id::text as id, publisher_workspace_id::text as publisher_workspace_id,
              recipient_workspace_id::text as recipient_workspace_id, status as current_status,
              capabilities, artifact_type, artifact_public_id, artifact_version_public_id, artifact_hash
       from collaboration_publications where public_id = $1 for update`,
      [publicId],
    );
    const publication = result.rows[0];
    if (!publication) return "not_found" as const;
    const isPublisher = publication.publisher_workspace_id === viewer.workspaceId;
    const isRecipient = publication.recipient_workspace_id === viewer.workspaceId;
    const valid = status === "submitted"
      ? isPublisher && publication.current_status === "draft"
      : status === "revoked"
        ? isPublisher && ["submitted", "accepted"].includes(publication.current_status)
        : isRecipient && publication.current_status === "submitted";
    if (!valid) return "invalid_transition" as const;
    await transaction.query(
      `update collaboration_publications set status = $2,
              submitted_at = case when $2 = 'submitted' then now() else submitted_at end,
              responded_at = case when $2 in ('accepted', 'rejected') then now() else responded_at end,
              responded_by = case when $2 in ('accepted', 'rejected') then $3 else responded_by end,
              revoked_at = case when $2 = 'revoked' then now() else revoked_at end,
              revoked_by = case when $2 = 'revoked' then $3 else revoked_by end,
              updated_at = now() where id = $1`,
      [publication.id, status, viewer.userId],
    );
    if (status === "accepted" && publication.capabilities.includes("import")) {
      await transaction.query(
        `insert into collaboration_imports (
           public_id, publication_id, workspace_id, imported_by, local_reference
         ) values ($1, $2, $3, $4, $5::jsonb)
         on conflict (publication_id, workspace_id) do nothing`,
        [
          createPublicId("imp"), publication.id, viewer.workspaceId, viewer.userId,
          JSON.stringify({
            kind: "governed_publication_reference", artifactType: publication.artifact_type,
            artifactPublicId: publication.artifact_public_id,
            artifactVersionPublicId: publication.artifact_version_public_id,
            artifactHash: publication.artifact_hash,
          }),
        ],
      );
    }
    await transaction.query(
      `insert into collaboration_events (
         public_id, publication_id, actor_workspace_id, actor_user_id, event_type, metadata
       ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [createPublicId("cev"), publication.id, viewer.workspaceId, viewer.userId, `publication.${status}`, JSON.stringify({ previousStatus: publication.current_status })],
    );
    if (status === "revoked") {
      await transaction.query(
        "update collaboration_imports set governance_status = 'archived', reviewed_at = coalesce(reviewed_at, now()) where publication_id = $1 and governance_status <> 'archived'",
        [publication.id],
      );
      await transaction.query(
        `update collaboration_delegations set status = 'cancelled', cancelled_at = now(), updated_at = now()
         where publication_id = $1 and status in ('proposed', 'accepted', 'in_progress')`,
        [publication.id],
      );
    }
    return { status };
  });
}

export async function createCollaborationDelegation(viewer: Viewer, input: {
  recipientWorkspacePublicId: string;
  publicationPublicId?: string | null;
  assigneeUserPublicId?: string | null;
  title: string;
  instructions: string;
  dueAt?: string | null;
}) {
  if (!canManage(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const recipient = await transaction.query<{ id: string }>(
      "select id::text as id from workspaces where public_id = $1 and id <> $2 limit 1",
      [input.recipientWorkspacePublicId, viewer.workspaceId],
    );
    if (!recipient.rows[0]) return "recipient_not_found" as const;
    let publicationId: string | null = null;
    if (input.publicationPublicId) {
      const publication = await transaction.query<{ id: string; capabilities: string[] }>(
        `select id::text as id, capabilities from collaboration_publications
         where public_id = $1 and publisher_workspace_id = $2 and recipient_workspace_id = $3
           and status in ('submitted', 'accepted') limit 1`,
        [input.publicationPublicId, viewer.workspaceId, recipient.rows[0].id],
      );
      if (!publication.rows[0]?.capabilities.includes("delegate")) return "publication_not_delegable" as const;
      publicationId = publication.rows[0].id;
    }
    let assigneeId: string | null = null;
    if (input.assigneeUserPublicId) {
      const assignee = await transaction.query<{ id: string }>(
        `select app_user.id::text as id from users app_user
         join workspace_members member on member.user_id = app_user.id
         where app_user.public_id = $1 and member.workspace_id = $2 limit 1`,
        [input.assigneeUserPublicId, recipient.rows[0].id],
      );
      if (!assignee.rows[0]) return "assignee_not_found" as const;
      assigneeId = assignee.rows[0].id;
    }
    const inserted = await transaction.query<{ id: string; public_id: string }>(
      `insert into collaboration_delegations (
         public_id, publication_id, sender_workspace_id, recipient_workspace_id,
         created_by, assigned_to, title, instructions, due_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id::text as id, public_id`,
      [
        createPublicId("dlg"), publicationId, viewer.workspaceId, recipient.rows[0].id,
        viewer.userId, assigneeId, input.title, input.instructions, input.dueAt ?? null,
      ],
    );
    await transaction.query(
      `insert into collaboration_events (public_id, delegation_id, actor_workspace_id, actor_user_id, event_type)
       values ($1, $2, $3, $4, 'delegation.proposed')`,
      [createPublicId("cev"), inserted.rows[0].id, viewer.workspaceId, viewer.userId],
    );
    return { publicId: inserted.rows[0].public_id, status: "proposed" as const };
  });
}

export async function updateCollaborationDelegationStatus(
  viewer: Viewer,
  publicId: string,
  status: Exclude<DelegationStatus, "proposed">,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      id: string; sender_workspace_id: string; recipient_workspace_id: string; current_status: DelegationStatus;
    }>(
      `select id::text as id, sender_workspace_id::text as sender_workspace_id,
              recipient_workspace_id::text as recipient_workspace_id, status as current_status
       from collaboration_delegations where public_id = $1 for update`,
      [publicId],
    );
    const delegation = result.rows[0];
    if (!delegation) return "not_found" as const;
    const recipient = delegation.recipient_workspace_id === viewer.workspaceId;
    const sender = delegation.sender_workspace_id === viewer.workspaceId;
    const allowed = status === "cancelled"
      ? sender && ["proposed", "accepted", "in_progress"].includes(delegation.current_status)
      : status === "accepted" || status === "rejected"
        ? recipient && delegation.current_status === "proposed"
        : status === "in_progress"
          ? recipient && delegation.current_status === "accepted"
          : recipient && delegation.current_status === "in_progress";
    if (!allowed) return "invalid_transition" as const;
    await transaction.query(
      `update collaboration_delegations set status = $2,
              accepted_at = case when $2 = 'accepted' then now() else accepted_at end,
              completed_at = case when $2 = 'completed' then now() else completed_at end,
              cancelled_at = case when $2 = 'cancelled' then now() else cancelled_at end,
              updated_at = now() where id = $1`,
      [delegation.id, status],
    );
    await transaction.query(
      `insert into collaboration_events (
         public_id, delegation_id, actor_workspace_id, actor_user_id, event_type, metadata
       ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [createPublicId("cev"), delegation.id, viewer.workspaceId, viewer.userId, `delegation.${status}`, JSON.stringify({ previousStatus: delegation.current_status })],
    );
    return { status };
  });
}

export async function listCollaboration(viewer: Viewer) {
  const database = await getDatabase();
  const [publicationsResult, delegationsResult] = await Promise.all([
    database.query<{
      public_id: string; publisher_public_id: string; publisher_name: string; recipient_public_id: string; recipient_name: string;
      publisher_workspace_id: string; artifact_type: PublicationArtifactType; artifact_public_id: string;
      artifact_version_public_id: string | null; artifact_hash: string; title: string; summary: string;
      capabilities: string[]; status: PublicationStatus; governance_status: string | null; created_at: string; updated_at: string;
    }>(
      `select publication.public_id, publisher.public_id as publisher_public_id, publisher.name as publisher_name,
              recipient.public_id as recipient_public_id, recipient.name as recipient_name,
              publication.publisher_workspace_id::text as publisher_workspace_id,
              publication.artifact_type, publication.artifact_public_id, publication.artifact_version_public_id,
              publication.artifact_hash, publication.title, publication.summary, publication.capabilities,
              publication.status, imported.governance_status,
              publication.created_at::text as created_at, publication.updated_at::text as updated_at
       from collaboration_publications publication
       join workspaces publisher on publisher.id = publication.publisher_workspace_id
       join workspaces recipient on recipient.id = publication.recipient_workspace_id
       left join collaboration_imports imported
         on imported.publication_id = publication.id and imported.workspace_id = $1
       where publication.publisher_workspace_id = $1
          or (publication.recipient_workspace_id = $1 and publication.status <> 'draft')
       order by publication.updated_at desc, publication.id desc limit 100`,
      [viewer.workspaceId],
    ),
    database.query<{
      public_id: string; publication_public_id: string | null; sender_public_id: string; sender_name: string;
      recipient_public_id: string; recipient_name: string; sender_workspace_id: string; assigned_to: string | null;
      title: string; instructions: string; due_at: string | null; status: DelegationStatus; created_at: string; updated_at: string;
    }>(
      `select delegation.public_id, publication.public_id as publication_public_id,
              sender.public_id as sender_public_id, sender.name as sender_name,
              recipient.public_id as recipient_public_id, recipient.name as recipient_name,
              delegation.sender_workspace_id::text as sender_workspace_id,
              assignee.public_id as assigned_to, delegation.title, delegation.instructions,
              delegation.due_at::text as due_at, delegation.status,
              delegation.created_at::text as created_at, delegation.updated_at::text as updated_at
       from collaboration_delegations delegation
       left join collaboration_publications publication on publication.id = delegation.publication_id
       join workspaces sender on sender.id = delegation.sender_workspace_id
       join workspaces recipient on recipient.id = delegation.recipient_workspace_id
       left join users assignee on assignee.id = delegation.assigned_to
       where delegation.sender_workspace_id = $1 or delegation.recipient_workspace_id = $1
       order by delegation.updated_at desc, delegation.id desc limit 100`,
      [viewer.workspaceId],
    ),
  ]);
  return {
    publications: publicationsResult.rows.map((row): CollaborationPublication => ({
      publicId: row.public_id, direction: row.publisher_workspace_id === viewer.workspaceId ? "outgoing" : "incoming",
      publisherWorkspace: { publicId: row.publisher_public_id, name: row.publisher_name },
      recipientWorkspace: { publicId: row.recipient_public_id, name: row.recipient_name },
      artifactType: row.artifact_type, artifactPublicId: row.artifact_public_id,
      artifactVersionPublicId: row.artifact_version_public_id, artifactHash: row.artifact_hash,
      title: row.title, summary: row.summary, capabilities: row.capabilities, status: row.status,
      governanceStatus: row.governance_status, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    delegations: delegationsResult.rows.map((row): CollaborationDelegation => ({
      publicId: row.public_id, direction: row.sender_workspace_id === viewer.workspaceId ? "outgoing" : "incoming",
      publicationPublicId: row.publication_public_id,
      senderWorkspace: { publicId: row.sender_public_id, name: row.sender_name },
      recipientWorkspace: { publicId: row.recipient_public_id, name: row.recipient_name },
      assignedTo: row.assigned_to, title: row.title, instructions: row.instructions, dueAt: row.due_at,
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
  };
}

const QUALITY_RANK: Record<QualityTier, number> = { basic: 0, standard: 1, high: 2, premium: 3 };

function routeConfigured(providerName: string) {
  return providerName.toLowerCase() === "deepseek"
    ? Boolean(process.env.DEEPSEEK_API_KEY?.trim())
    : Boolean(process.env.OPENAI_API_KEY?.trim());
}

function estimatedRouteCost(route: {
  input_price_micros_per_million: string | number;
  output_price_micros_per_million: string | number;
}, inputTokens: number, outputTokens: number) {
  return Math.round(
    (Number(route.input_price_micros_per_million) * inputTokens
      + Number(route.output_price_micros_per_million) * outputTokens) / 1_000_000,
  );
}

function allocationBucket(subjectKey: string, versionId: string, totalWeight: number) {
  const digest = createHash("sha256").update(`${versionId}:${subjectKey}`).digest();
  return digest.readUInt32BE(0) % totalWeight;
}

export async function createRoutingPolicyVersion(viewer: Viewer, input: {
  policyKey: string;
  name: string;
  stage: ProviderStage;
  description: string;
  selectionMode: "weighted" | "priority";
  maxEstimatedCostMicros: number | null;
  maxLatencyMs: number | null;
  minimumQualityTier: QualityTier;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  changeNote: string;
  routes: Array<{
    routeKey: string;
    providerName: string;
    model: string;
    protocol: "responses" | "chat_completions";
    priority: number;
    weight: number;
    qualityTier: QualityTier;
    expectedLatencyMs: number | null;
    inputPriceMicrosPerMillion: number;
    outputPriceMicrosPerMillion: number;
    pricingSource: string;
    pricingEffectiveAt: string;
  }>;
}) {
  if (!canManage(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtext($1))", [`routing:${viewer.workspaceId}:${input.policyKey}`]);
    let policy = await transaction.query<{ id: string; public_id: string; stage: ProviderStage }>(
      `select id::text as id, public_id, stage from provider_routing_policies
       where workspace_id = $1 and policy_key = $2 for update`,
      [viewer.workspaceId, input.policyKey],
    );
    if (policy.rows[0] && policy.rows[0].stage !== input.stage) return "stage_conflict" as const;
    if (!policy.rows[0]) {
      policy = await transaction.query<{ id: string; public_id: string; stage: ProviderStage }>(
        `insert into provider_routing_policies (
           public_id, workspace_id, created_by, policy_key, name, stage, description
         ) values ($1, $2, $3, $4, $5, $6, $7)
         returning id::text as id, public_id, stage`,
        [createPublicId("rpl"), viewer.workspaceId, viewer.userId, input.policyKey, input.name, input.stage, input.description],
      );
    } else {
      await transaction.query(
        "update provider_routing_policies set name = $2, description = $3, updated_at = now() where id = $1",
        [policy.rows[0].id, input.name, input.description],
      );
    }
    const versionNumber = await transaction.query<{ version: number }>(
      "select coalesce(max(version), 0)::int + 1 as version from provider_routing_policy_versions where policy_id = $1",
      [policy.rows[0].id],
    );
    const version = await transaction.query<{ id: string; public_id: string }>(
      `insert into provider_routing_policy_versions (
         public_id, policy_id, version, selection_mode, max_estimated_cost_micros,
         max_latency_ms, minimum_quality_tier, estimated_input_tokens,
         estimated_output_tokens, change_note, created_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id::text as id, public_id`,
      [
        createPublicId("rpv"), policy.rows[0].id, versionNumber.rows[0].version, input.selectionMode,
        input.maxEstimatedCostMicros, input.maxLatencyMs, input.minimumQualityTier,
        input.estimatedInputTokens, input.estimatedOutputTokens, input.changeNote, viewer.userId,
      ],
    );
    for (const route of input.routes) {
      await transaction.query(
        `insert into provider_routing_routes (
           public_id, policy_version_id, route_key, provider_name, model, protocol,
           priority, weight, quality_tier, expected_latency_ms,
           input_price_micros_per_million, output_price_micros_per_million,
           pricing_source, pricing_effective_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          createPublicId("rte"), version.rows[0].id, route.routeKey, route.providerName, route.model,
          route.protocol, route.priority, route.weight, route.qualityTier, route.expectedLatencyMs,
          route.inputPriceMicrosPerMillion, route.outputPriceMicrosPerMillion,
          route.pricingSource, route.pricingEffectiveAt,
        ],
      );
    }
    return {
      policyPublicId: policy.rows[0].public_id, versionPublicId: version.rows[0].public_id,
      version: versionNumber.rows[0].version, status: "draft" as const,
    };
  });
}

export async function activateRoutingPolicyVersion(viewer: Viewer, versionPublicId: string) {
  if (!canManage(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const version = await transaction.query<{ id: string; policy_id: string; stage: ProviderStage }>(
      `select version.id::text as id, version.policy_id::text as policy_id, policy.stage
       from provider_routing_policy_versions version
       join provider_routing_policies policy on policy.id = version.policy_id
       where version.public_id = $1 and policy.workspace_id = $2 for update`,
      [versionPublicId, viewer.workspaceId],
    );
    if (!version.rows[0]) return "not_found" as const;
    await transaction.query("select pg_advisory_xact_lock(hashtext($1))", [`routing-stage:${viewer.workspaceId}:${version.rows[0].stage}`]);
    const eligible = await transaction.query<{ routes: number }>(
      `select count(*)::int as routes from provider_routing_routes
       where policy_version_id = $1 and enabled`,
      [version.rows[0].id],
    );
    if (eligible.rows[0].routes < 1) return "routes_missing" as const;
    await transaction.query(
      `update provider_routing_policy_versions candidate set status = 'retired', retired_at = now()
       from provider_routing_policies policy
       where candidate.policy_id = policy.id and policy.workspace_id = $1 and policy.stage = $2
         and candidate.status = 'active' and candidate.id <> $3`,
      [viewer.workspaceId, version.rows[0].stage, version.rows[0].id],
    );
    await transaction.query(
      `update provider_routing_policy_versions set status = 'active', activated_at = coalesce(activated_at, now()), retired_at = null
       where id = $1`,
      [version.rows[0].id],
    );
    return { status: "active" as const };
  });
}

export async function resolveProviderRoute(input: {
  queryable: Queryable;
  workspaceId: string;
  runId: string;
  taskId: string | null;
  stage: ProviderStage;
  subjectKey: string;
  runtimeKind?: "study" | "agent";
}): Promise<null | {
  decisionId: string;
  decisionPublicId: string;
  override: ProviderRouteOverride;
  selectionReason: string;
}> {
  const runtimeKind = input.runtimeKind ?? "study";
  const runColumn = runtimeKind === "agent" ? "agent_run_id" : "run_id";
  await input.queryable.query("select pg_advisory_xact_lock(hashtext($1))", [`${runtimeKind}-run-routing:${input.runId}:${input.stage}`]);
  let binding = await input.queryable.query<{ id: string; policy_version_id: string }>(
    `select id::text as id, policy_version_id::text as policy_version_id from study_run_routing_bindings where ${runColumn} = $1 and stage = $2`,
    [input.runId, input.stage],
  );
  if (!binding.rows[0]) {
    const active = await input.queryable.query<{ id: string }>(
      `select version.id::text as id from provider_routing_policy_versions version
       join provider_routing_policies policy on policy.id = version.policy_id
       where policy.workspace_id = $1 and policy.stage = $2 and version.status = 'active'
       order by version.activated_at desc, version.id desc limit 1`,
      [input.workspaceId, input.stage],
    );
    if (!active.rows[0]) return null;
    binding = await input.queryable.query<{ id: string; policy_version_id: string }>(
      `insert into study_run_routing_bindings (public_id, ${runColumn}, workspace_id, stage, policy_version_id)
       values ($1, $2, $3, $4, $5)
       returning id::text as id, policy_version_id::text as policy_version_id`,
      [createPublicId("rrb"), input.runId, input.workspaceId, input.stage, active.rows[0].id],
    );
  }
  const version = await input.queryable.query<{
    public_id: string; selection_mode: "weighted" | "priority"; max_estimated_cost_micros: string | null;
    max_latency_ms: number | null; minimum_quality_tier: QualityTier; estimated_input_tokens: number; estimated_output_tokens: number;
  }>(
    `select public_id, selection_mode, max_estimated_cost_micros::text as max_estimated_cost_micros,
            max_latency_ms, minimum_quality_tier, estimated_input_tokens, estimated_output_tokens
     from provider_routing_policy_versions where id = $1`,
    [binding.rows[0].policy_version_id],
  );
  const routes = await input.queryable.query<{
    id: string; public_id: string; route_key: string; provider_name: string; model: string;
    protocol: "responses" | "chat_completions"; priority: number; weight: number; quality_tier: QualityTier;
    expected_latency_ms: number | null; input_price_micros_per_million: string;
    output_price_micros_per_million: string; pricing_source: string; pricing_effective_at: string;
  }>(
    `select id::text as id, public_id, route_key, provider_name, model, protocol, priority,
            weight, quality_tier, expected_latency_ms,
            input_price_micros_per_million::text as input_price_micros_per_million,
            output_price_micros_per_million::text as output_price_micros_per_million,
            pricing_source, pricing_effective_at::text as pricing_effective_at
     from provider_routing_routes where policy_version_id = $1 and enabled order by priority, id`,
    [binding.rows[0].policy_version_id],
  );
  const policy = version.rows[0];
  const candidates = routes.rows.map((route) => {
    const estimatedCostMicros = estimatedRouteCost(route, policy.estimated_input_tokens, policy.estimated_output_tokens);
    const rejections = [
      ...(!routeConfigured(route.provider_name) ? ["provider_not_configured"] : []),
      ...(QUALITY_RANK[route.quality_tier] < QUALITY_RANK[policy.minimum_quality_tier] ? ["quality_below_minimum"] : []),
      ...(policy.max_latency_ms !== null && route.expected_latency_ms !== null && route.expected_latency_ms > policy.max_latency_ms ? ["latency_above_ceiling"] : []),
      ...(policy.max_estimated_cost_micros !== null && estimatedCostMicros > Number(policy.max_estimated_cost_micros) ? ["cost_above_ceiling"] : []),
    ];
    return { ...route, estimatedCostMicros, eligible: rejections.length === 0, rejections };
  });
  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (!eligible.length) throw new Error(`PROVIDER_ROUTING_NO_ELIGIBLE_ROUTE:${input.stage}`);
  let selected = eligible[0];
  let selectionReason = `priority:${selected.priority}`;
  if (policy.selection_mode === "weighted") {
    const totalWeight = eligible.reduce((sum, candidate) => sum + candidate.weight, 0);
    let bucket = allocationBucket(`${input.subjectKey}:${input.taskId ?? "run"}`, policy.public_id, totalWeight);
    selected = eligible.find((candidate) => {
      if (bucket < candidate.weight) return true;
      bucket -= candidate.weight;
      return false;
    }) ?? eligible.at(-1)!;
    selectionReason = `weighted:${selected.weight}/${totalWeight}`;
  }
  const decision = await input.queryable.query<{ id: string; public_id: string }>(
    `insert into provider_route_decisions (
       public_id, binding_id, run_id, agent_run_id, workspace_id, task_id, stage, chosen_route_id,
       provider_name, model, protocol, selection_reason, candidate_snapshot, estimated_cost_micros
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
     returning id::text as id, public_id`,
    [
      createPublicId("prd"), binding.rows[0].id,
      runtimeKind === "study" ? input.runId : null,
      runtimeKind === "agent" ? input.runId : null,
      input.workspaceId, runtimeKind === "study" ? input.taskId : null,
      input.stage, selected.id, selected.provider_name, selected.model, selected.protocol,
      selectionReason,
      JSON.stringify(candidates.map((candidate) => ({
        routePublicId: candidate.public_id, routeKey: candidate.route_key, providerName: candidate.provider_name,
        model: candidate.model, priority: candidate.priority, weight: candidate.weight,
        qualityTier: candidate.quality_tier, expectedLatencyMs: candidate.expected_latency_ms,
        estimatedCostMicros: candidate.estimatedCostMicros, pricingSource: candidate.pricing_source,
        pricingEffectiveAt: candidate.pricing_effective_at, eligible: candidate.eligible,
        rejectionReasons: candidate.rejections,
      }))),
      selected.estimatedCostMicros,
    ],
  );
  return {
    decisionId: decision.rows[0].id,
    decisionPublicId: decision.rows[0].public_id,
    selectionReason,
    override: {
      stage: input.stage, providerName: selected.provider_name, model: selected.model,
      protocol: selected.protocol,
    },
  };
}

function tokenUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return { inputTokens: 0, outputTokens: 0 };
  const value = usage as Record<string, unknown>;
  const inputTokens = Number(value.input_tokens ?? value.prompt_tokens ?? value.inputTokens ?? 0);
  const outputTokens = Number(value.output_tokens ?? value.completion_tokens ?? value.outputTokens ?? 0);
  return {
    inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? Math.round(inputTokens) : 0,
    outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? Math.round(outputTokens) : 0,
  };
}

export async function finishProviderRouteDecision(input: {
  queryable: Queryable;
  decisionId: string;
  usage?: unknown;
  latencyMs: number;
  qualityScore?: number | null;
  errorCode?: string | null;
}) {
  const usage = tokenUsage(input.usage);
  await input.queryable.query(
    `update provider_route_decisions decision set
       status = case when $6::text is null then 'completed' else 'failed' end,
       input_tokens = $2, output_tokens = $3,
       actual_cost_micros = round((route.input_price_micros_per_million * $2
         + route.output_price_micros_per_million * $3)::numeric / 1000000)::bigint,
       latency_ms = $4, quality_score = $5, error_code = $6, finished_at = now()
     from provider_routing_routes route
     where decision.id = $1 and route.id = decision.chosen_route_id and decision.finished_at is null`,
    [input.decisionId, usage.inputTokens, usage.outputTokens, Math.max(0, Math.round(input.latencyMs)), input.qualityScore ?? null, input.errorCode ?? null],
  );
}

export async function listRoutingControl(viewer: Viewer) {
  const database = await getDatabase();
  const [policiesResult, decisionsResult] = await Promise.all([
    database.query<{
      public_id: string; policy_key: string; name: string; stage: ProviderStage; description: string; versions: unknown;
    }>(
      `select policy.public_id, policy.policy_key, policy.name, policy.stage, policy.description,
              coalesce(jsonb_agg(jsonb_build_object(
                'publicId', version.public_id, 'version', version.version, 'status', version.status,
                'selectionMode', version.selection_mode, 'maxEstimatedCostMicros', version.max_estimated_cost_micros,
                'maxLatencyMs', version.max_latency_ms, 'minimumQualityTier', version.minimum_quality_tier,
                'estimatedInputTokens', version.estimated_input_tokens, 'estimatedOutputTokens', version.estimated_output_tokens,
                'changeNote', version.change_note, 'routes', coalesce(routes.items, '[]'::jsonb)
              ) order by version.version desc) filter (where version.id is not null), '[]'::jsonb) as versions
       from provider_routing_policies policy
       left join provider_routing_policy_versions version on version.policy_id = policy.id
       left join lateral (
         select jsonb_agg(jsonb_build_object(
           'routeKey', route.route_key, 'providerName', route.provider_name, 'model', route.model,
           'protocol', route.protocol, 'priority', route.priority, 'weight', route.weight,
           'qualityTier', route.quality_tier, 'expectedLatencyMs', route.expected_latency_ms,
           'inputPriceMicrosPerMillion', route.input_price_micros_per_million,
           'outputPriceMicrosPerMillion', route.output_price_micros_per_million,
           'pricingSource', route.pricing_source, 'pricingEffectiveAt', route.pricing_effective_at,
           'enabled', route.enabled
         ) order by route.priority, route.id) as items
         from provider_routing_routes route where route.policy_version_id = version.id
       ) routes on true
       where policy.workspace_id = $1
       group by policy.id order by policy.updated_at desc, policy.id desc`,
      [viewer.workspaceId],
    ),
    database.query<{
      public_id: string; run_public_id: string; study_public_id: string | null; runtime_kind: "study" | "agent"; stage: ProviderStage;
      provider_name: string; model: string; selection_reason: string; estimated_cost_micros: string;
      actual_cost_micros: string | null; latency_ms: number | null; quality_score: number | null;
      status: RouteDecisionSummary["status"]; created_at: string;
    }>(
      `select decision.public_id, coalesce(run.public_id, agent_run.public_id) as run_public_id,
              study.public_id as study_public_id,
              case when decision.agent_run_id is null then 'study' else 'agent' end as runtime_kind,
              decision.stage, decision.provider_name, decision.model, decision.selection_reason,
              decision.estimated_cost_micros::text as estimated_cost_micros,
              decision.actual_cost_micros::text as actual_cost_micros, decision.latency_ms,
              decision.quality_score, decision.status, decision.created_at::text as created_at
       from provider_route_decisions decision
       left join study_runs run on run.id = decision.run_id
       left join studies study on study.id = run.study_id
       left join agent_runs agent_run on agent_run.id = decision.agent_run_id
       where decision.workspace_id = $1 order by decision.created_at desc, decision.id desc limit 50`,
      [viewer.workspaceId],
    ),
  ]);
  return {
    policies: policiesResult.rows.map((row): RoutingPolicySummary => ({
      publicId: row.public_id, policyKey: row.policy_key, name: row.name, stage: row.stage,
      description: row.description,
      versions: parsedJson<RoutingPolicySummary["versions"]>(row.versions as RoutingPolicySummary["versions"] | string),
    })),
    decisions: decisionsResult.rows.map((row): RouteDecisionSummary => ({
      publicId: row.public_id, runPublicId: row.run_public_id, studyPublicId: row.study_public_id, runtimeKind: row.runtime_kind,
      stage: row.stage, providerName: row.provider_name, model: row.model,
      selectionReason: row.selection_reason, estimatedCostMicros: Number(row.estimated_cost_micros),
      actualCostMicros: row.actual_cost_micros === null ? null : Number(row.actual_cost_micros),
      latencyMs: row.latency_ms, qualityScore: row.quality_score, status: row.status, createdAt: row.created_at,
    })),
  };
}
