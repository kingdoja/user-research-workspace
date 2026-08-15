import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  createContextAsset,
  listContextMemoryPolicies,
  updateContextMemoryPolicy,
} from "../src/lib/context-system";
import {
  confirmStudyPlan,
  createStudy,
  getStudy,
  submitStudyClarification,
} from "../src/lib/studies";
import { getStudyRunComparison } from "../src/lib/study-run-replay";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.INTENT_WORKFLOW_CONTRACT_SMOKE_CONFIRM !== "1") {
  throw new Error("Set INTENT_WORKFLOW_CONTRACT_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Intent workflow contract smoke test only runs against a local database.");
}
process.env.OPENAI_API_KEY = "";

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID()];
const workspaceIds: string[] = [];

async function main() {
  const database = await getDatabase();
  try {
    const actors = await database.transaction(async (transaction) => {
      for (const [index, authUserId] of authUserIds.entries()) {
        await transaction.query(
          `insert into auth.users (id, email, raw_user_meta_data)
           values ($1, $2, $3::jsonb)`,
          [authUserId, `intent-workflow-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `Intent smoke ${index}` })],
        );
      }
      return (await transaction.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id
         from users app_user
         join workspace_members member on member.user_id = app_user.id and member.role = 'owner'
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = any($1::uuid[])
         order by app_user.email`,
        [authUserIds],
      )).rows;
    });
    workspaceIds.push(...actors.map((actor) => actor.workspace_id));
    const viewer = {
      userId: actors[0].user_id,
      userPublicId: actors[0].user_public_id,
      displayName: "Intent smoke owner",
      email: `intent-workflow-0-${suffix}@example.com`,
      workspaceId: actors[0].workspace_id,
      workspacePublicId: actors[0].workspace_public_id,
      workspaceName: "Intent smoke workspace",
      role: "owner" as const,
      tokenBalance: 0,
    };
    const otherViewer = {
      ...viewer,
      userId: actors[1].user_id,
      userPublicId: actors[1].user_public_id,
      workspaceId: actors[1].workspace_id,
      workspacePublicId: actors[1].workspace_public_id,
      email: `intent-workflow-1-${suffix}@example.com`,
    };

    const policies = await listContextMemoryPolicies(viewer);
    const corePolicy = policies.find((policy) => policy.memoryKind === "core");
    assert(corePolicy);
    await updateContextMemoryPolicy(viewer, corePolicy.publicId, {
      allowedPurposes: ["research_execution", "report_generation"],
      reviewRequired: true,
      defaultRetentionDays: null,
      decayDays: 365,
      promotionMinObservations: 2,
      conflictStrategy: "manual_review",
    });
    const deniedCore = await createContextAsset(viewer, {
      assetType: "core_memory", scope: "user", studyPublicId: null,
      title: `被规划策略拒绝的偏好 ${suffix}`, description: "Purpose denial fixture", sourceUri: null,
      content: `咖啡订阅 ${suffix}：只允许在执行阶段使用这条个人偏好。`, changeNote: "Intent smoke",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "human", consentStatus: "confirmed", piiStatus: "none",
      retentionExpiresAt: null, memoryConfidence: "high", reviewStatus: "approved",
    });
    assert.equal(typeof deniedCore, "object");
    const allowedTeam = await createContextAsset(viewer, {
      assetType: "team_memory", scope: "workspace", studyPublicId: null,
      title: `团队咖啡订阅研究原则 ${suffix}`, description: "Allowed intent fixture", sourceUri: null,
      content: `咖啡订阅 ${suffix}：团队要求优先验证留存动机、价格阻力与取消路径。`, changeNote: "Intent smoke",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "human", consentStatus: "confirmed", piiStatus: "none",
      retentionExpiresAt: null, memoryConfidence: "high", reviewStatus: "approved",
    });
    assert.equal(typeof allowedTeam, "object");
    if (typeof allowedTeam !== "object") throw new Error("TEAM_MEMORY_CREATE_FAILED");
    const retiredPersonaPublicId = `per_retired_${suffix}`;
    await database.query(
      `insert into study_personas (
         public_id, workspace_id, created_by, name, archetype, profile,
         source, visibility, retention_status
       ) values ($1, $2, $3, '已退役咖啡订阅 Persona', 'Retired fixture', '{}'::jsonb,
                 'manual', 'workspace', 'retired')`,
      [retiredPersonaPublicId, viewer.workspaceId, viewer.userId],
    );
    const retiredPersonaAsset = await createContextAsset(viewer, {
      assetType: "persona", scope: "workspace", studyPublicId: null,
      title: `已退役咖啡订阅 Persona ${suffix}`, description: "Persona retention gate", sourceUri: null,
      content: `咖啡订阅 ${suffix}：这条已退役 Persona 不得参与 Intent Planning。`, changeNote: "Intent smoke",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "synthetic", consentStatus: "not_required", piiStatus: "none",
      retentionExpiresAt: null, memoryConfidence: "low", reviewStatus: "approved",
    });
    assert.equal(typeof retiredPersonaAsset, "object");
    if (typeof retiredPersonaAsset !== "object") throw new Error("RETIRED_PERSONA_ASSET_CREATE_FAILED");
    await database.query(
      `update context_assets set origin_kind = 'study_persona', origin_public_id = $2
       where public_id = $1`,
      [retiredPersonaAsset.publicId, retiredPersonaPublicId],
    );

    const studyPublicId = await createStudy(
      viewer,
      `研究咖啡订阅 ${suffix} 用户的留存动机、价格阻力与取消路径，支持下一季度产品决策。`,
    );
    const studyRow = await database.query<{ id: string }>(
      "select id::text as id from studies where public_id = $1",
      [studyPublicId],
    );
    const studyId = studyRow.rows[0].id;
    const firstIntent = await database.query<{
      id: string; public_id: string; version: number; lifecycle_status: string;
      content_hash: string; supersedes_intent_version_id: string | null;
      context_retrieval_id: string; purpose: string; policy_decision: Record<string, unknown> | string;
    }>(
      `select intent.id::text as id, intent.public_id, intent.version, intent.lifecycle_status,
              intent.content_hash, intent.supersedes_intent_version_id::text as supersedes_intent_version_id,
              intent.context_retrieval_id::text as context_retrieval_id,
              retrieval.purpose, retrieval.policy_decision
       from study_intent_versions intent
       join context_retrievals retrieval on retrieval.id = intent.context_retrieval_id
       where intent.study_id = $1 order by intent.version`,
      [studyId],
    );
    assert.equal(firstIntent.rows.length, 1);
    assert.equal(firstIntent.rows[0].lifecycle_status, "draft");
    assert.equal(firstIntent.rows[0].purpose, "intent_planning");
    const firstDecision = typeof firstIntent.rows[0].policy_decision === "string"
      ? JSON.parse(firstIntent.rows[0].policy_decision)
      : firstIntent.rows[0].policy_decision;
    assert(Number(firstDecision.deniedMemoryChunks) > 0);
    const retrievedAssets = await database.query<{ public_id: string }>(
      `select distinct asset.public_id
       from context_retrieval_items item
       join context_chunks chunk on chunk.id = item.chunk_id
       join context_asset_versions version on version.id = chunk.asset_version_id
       join context_assets asset on asset.id = version.asset_id
       where item.retrieval_id = $1`,
      [firstIntent.rows[0].context_retrieval_id],
    );
    assert(retrievedAssets.rows.some((asset) => asset.public_id === allowedTeam.publicId));
    assert(!retrievedAssets.rows.some((asset) => asset.public_id === retiredPersonaAsset.publicId));
    if (typeof deniedCore === "object") {
      assert(!retrievedAssets.rows.some((asset) => asset.public_id === deniedCore.publicId));
    }

    assert.equal(await submitStudyClarification(viewer, studyPublicId, [
      { questionId: "business_goal", selected: ["产品定位与优先级"] },
      { questionId: "research_focus", selected: ["完整决策路径", "核心痛点与未满足需求"] },
      { questionId: "target_audience", selected: ["现有用户"] },
      { questionId: "research_scope", selected: ["公开资料 + AI 合成 Persona 模拟访谈"] },
    ]), "completed");
    assert.equal(await submitStudyClarification(viewer, studyPublicId, [
      { questionId: "business_goal", selected: ["产品定位与优先级"] },
      { questionId: "research_focus", selected: ["完整决策路径"] },
      { questionId: "target_audience", selected: ["现有用户"] },
      { questionId: "research_scope", selected: ["公开资料 + AI 合成 Persona 模拟访谈"] },
    ]), "already_completed");

    assert.equal(await confirmStudyPlan(viewer, studyPublicId), "confirmed");
    assert.equal(await confirmStudyPlan(viewer, studyPublicId), "already_confirmed");
    const contracts = await database.query<{
      id: string; public_id: string; version: number; lifecycle_status: string;
      content_hash: string; supersedes_intent_version_id: string | null;
    }>(
      `select id::text as id, public_id, version, lifecycle_status, content_hash,
              supersedes_intent_version_id::text as supersedes_intent_version_id
       from study_intent_versions where study_id = $1 order by version`,
      [studyId],
    );
    assert.equal(contracts.rows.length, 3);
    assert.deepEqual(contracts.rows.map((row) => row.lifecycle_status), ["draft", "draft", "confirmed"]);
    assert.equal(contracts.rows[1].supersedes_intent_version_id, contracts.rows[0].id);
    assert.equal(contracts.rows[2].supersedes_intent_version_id, contracts.rows[1].id);
    assert.notEqual(contracts.rows[0].content_hash, contracts.rows[1].content_hash);
    assert.equal(contracts.rows[1].content_hash, contracts.rows[2].content_hash);

    const locked = await database.query<{
      plan_intent_id: string; run_intent_id: string; workflow_intent_id: string;
      run_workflow_id: string; workflow_id: string; plan_id: string; workflow_plan_id: string;
      task_graph: unknown[] | string; content_hash: string;
    }>(
      `select plan.intent_version_id::text as plan_intent_id,
              run.intent_version_id::text as run_intent_id,
              workflow.intent_version_id::text as workflow_intent_id,
              run.workflow_definition_id::text as run_workflow_id,
              workflow.id::text as workflow_id, plan.id::text as plan_id,
              workflow.plan_version_id::text as workflow_plan_id,
              workflow.task_graph, workflow.content_hash
       from study_runs run
       join study_plan_versions plan on plan.id = run.plan_version_id
       join workflow_definitions workflow on workflow.id = run.workflow_definition_id
       where run.study_id = $1`,
      [studyId],
    );
    assert.equal(locked.rows.length, 1);
    assert.equal(locked.rows[0].plan_intent_id, contracts.rows[2].id);
    assert.equal(locked.rows[0].run_intent_id, contracts.rows[2].id);
    assert.equal(locked.rows[0].workflow_intent_id, contracts.rows[2].id);
    assert.equal(locked.rows[0].run_workflow_id, locked.rows[0].workflow_id);
    assert.equal(locked.rows[0].workflow_plan_id, locked.rows[0].plan_id);
    const taskGraph = typeof locked.rows[0].task_graph === "string" ? JSON.parse(locked.rows[0].task_graph) : locked.rows[0].task_graph;
    assert(taskGraph.length > 0);
    await assert.rejects(
      database.query("update study_intent_versions set objective = 'mutated' where id = $1", [contracts.rows[2].id]),
      /immutable/,
    );
    await assert.rejects(
      database.query("update workflow_definitions set compiler_version = 'mutated' where id = $1", [locked.rows[0].workflow_id]),
      /immutable/,
    );

    const detail = await getStudy(viewer, studyPublicId);
    assert(detail?.intent && detail.workflow);
    assert.equal(detail.intent.context?.purpose, "intent_planning");
    assert.equal(detail.workflow.taskCount, taskGraph.length);
    assert.equal(await getStudy(otherViewer, studyPublicId), null);
    assert.equal(await getStudyRunComparison(otherViewer, studyPublicId), null);

    const legacyStudy = await database.query<{ id: string }>(
      `insert into studies (
         public_id, workspace_id, created_by, title, brief, study_type,
         status, current_stage, estimated_tokens
       ) values ($1, $2, $3, 'Legacy binding fixture', '历史数据不推测 Intent',
                 'user_research', 'queued', 'execution', 1000)
       returning id::text as id`,
      [`std_legacy_${suffix}`, viewer.workspaceId, viewer.userId],
    );
    const legacyPlan = await createSmokePlanVersion(database, legacyStudy.rows[0].id, viewer.userId);
    const legacyRun = await database.query<{ intent_version_id: string | null; workflow_definition_id: string | null }>(
      `insert into study_runs (study_id, plan_version_id, status)
       values ($1, $2, 'awaiting_provider')
       returning intent_version_id::text as intent_version_id,
                 workflow_definition_id::text as workflow_definition_id`,
      [legacyStudy.rows[0].id, legacyPlan.id],
    );
    assert.equal(legacyRun.rows[0].intent_version_id, null);
    assert.equal(legacyRun.rows[0].workflow_definition_id, null);

    console.log(JSON.stringify({
      intentVersions: contracts.rows.map((row) => ({ publicId: row.public_id, version: row.version, status: row.lifecycle_status })),
      workflowDefinitionId: locked.rows[0].workflow_id,
      planningContextPurpose: detail.intent.context?.purpose,
      planningCitationCount: detail.intent.context?.citationCount,
      policyDeniedMemoryChunks: detail.intent.context?.policyDecision.deniedMemoryChunks,
      retiredPersonaExcluded: true,
      runBindingsLocked: true,
      immutable: true,
      idempotent: true,
      crossWorkspaceHidden: true,
      legacyBindingsRemainNull: true,
    }, null, 2));
  } finally {
    for (const workspaceId of workspaceIds) {
      await database.query("delete from workspaces where id = $1", [workspaceId]);
    }
    for (const authUserId of authUserIds) {
      await database.query("delete from auth.users where id = $1", [authUserId]);
    }
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
