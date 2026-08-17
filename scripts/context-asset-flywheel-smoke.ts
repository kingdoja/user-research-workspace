import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  createContextAsset,
  createContextEdge,
  proposeStudyContextCandidates,
  publishContextVersion,
  retrieveContext,
  reviewContextAsset,
} from "../src/lib/context-system";

if (process.env.CONTEXT_ASSET_FLYWHEEL_SMOKE_CONFIRM !== "1") {
  throw new Error("Set CONTEXT_ASSET_FLYWHEEL_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Context asset flywheel smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

function requireAsset(result: Awaited<ReturnType<typeof createContextAsset>>) {
  assert.notEqual(result, "forbidden");
  assert.notEqual(result, "study_not_found");
  if (typeof result === "string") throw new Error(`CONTEXT_ASSET_CREATE_FAILED:${result}`);
  return result;
}

async function main() {
  const database = await getDatabase();
  try {
    const actor = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Context asset flywheel smoke"}'::jsonb)`,
        [authUserId, `context-flywheel-${suffix}@example.com`],
      );
      const result = await transaction.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id
         from users app_user
         join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      return result.rows[0];
    });
    workspaceId = actor.workspace_id;
    const viewer = {
      userId: actor.user_id,
      userPublicId: actor.user_public_id,
      displayName: "Context asset flywheel smoke",
      email: `context-flywheel-${suffix}@example.com`,
      workspaceId: actor.workspace_id,
      workspacePublicId: actor.workspace_public_id,
      workspaceName: "Context asset flywheel smoke",
      role: "owner" as const,
      tokenBalance: 0,
    };

    const pending = requireAsset(await createContextAsset(viewer, {
      assetType: "research_sample",
      scope: "workspace",
      studyPublicId: null,
      title: "雨天通勤访谈导入",
      description: "验证待审核资产不会进入 Runtime",
      sourceUri: "https://example.com/interviews/rainy-commute",
      content: `雨天通勤样本 ${suffix}：受访者会优先选择直达公交，避免多次换乘。`,
      changeNote: "Imported by smoke",
      ingestionMethod: "file",
      sourceName: `rainy-commute-${suffix}.md`,
      sourceMimeType: "text/markdown",
      evidenceKind: "human",
      consentStatus: "confirmed",
      piiStatus: "redacted",
      retentionExpiresAt: "2027-08-15T23:59:59.000Z",
      reviewStatus: "pending",
    }));
    const beforeApproval = await retrieveContext({
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: `雨天通勤样本 ${suffix}`,
      limit: 10,
      audit: false,
    });
    assert(!beforeApproval.citations.some((item) => item.assetPublicId === pending.publicId));

    const approved = await reviewContextAsset(viewer, pending.publicId, {
      action: "approve",
      note: "同意状态与脱敏结果已复核",
    });
    assert.equal(typeof approved, "object");
    const afterApproval = await retrieveContext({
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: `雨天通勤样本 ${suffix}`,
      limit: 10,
      audit: false,
    });
    assert(afterApproval.citations.some((item) => item.assetPublicId === pending.publicId));

    const related = requireAsset(await createContextAsset(viewer, {
      assetType: "document",
      scope: "workspace",
      studyPublicId: null,
      title: "通勤研究方法说明",
      description: "资产关系目标",
      sourceUri: null,
      content: `通勤研究方法说明 ${suffix}`,
      changeNote: "Smoke fixture",
      ingestionMethod: "manual",
      sourceName: null,
      sourceMimeType: null,
      evidenceKind: "not_applicable",
      consentStatus: "not_required",
      piiStatus: "none",
      retentionExpiresAt: null,
      reviewStatus: "approved",
    }));
    const edge = await createContextEdge(viewer, pending.publicId, {
      targetPublicId: related.publicId,
      relation: "supports",
      note: "访谈样本支持方法说明",
    });
    assert.equal(typeof edge, "object");

    const version = await publishContextVersion(viewer, pending.publicId, {
      content: `雨天通勤修订样本 ${suffix}：补充了受访者选择公交时的决策依据。`,
      changeNote: "补充决策依据",
    });
    assert.equal(typeof version, "object");
    if (typeof version !== "object") throw new Error("CONTEXT_VERSION_PUBLISH_FAILED");
    assert.equal(version.version, 2);
    const afterVersion = await retrieveContext({
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: `雨天通勤修订样本 ${suffix}`,
      limit: 10,
      audit: false,
    });
    assert(!afterVersion.citations.some((item) => item.assetPublicId === pending.publicId));
    const rejected = await reviewContextAsset(viewer, pending.publicId, {
      action: "reject",
      note: "修订版本仍需补充抽样说明",
    });
    assert.equal(typeof rejected, "object");
    const afterRejection = await retrieveContext({
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: `雨天通勤修订样本 ${suffix}`,
      limit: 10,
      audit: false,
    });
    assert(!afterRejection.citations.some((item) => item.assetPublicId === pending.publicId));

    const proposalInput = {
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      studyPublicId: `std_${suffix}`,
      report: {
        publicId: `rpt_${suffix}`,
        title: "通勤研究报告",
        executiveSummary: "研究发现雨天时直达性比总时长更重要。",
        content: {
          finding: "直达性优先",
          evidenceRefs: [pending.publicId],
          nextQuestions: ["不同城区的换乘距离是否改变雨天直达偏好？", "极端天气下等待时间与直达性如何权衡？"],
          limitations: ["当前样本未覆盖夜间轮班通勤者，需要补充验证。"],
        },
      },
      personas: [
        { publicId: `per_commuter_${suffix}`, name: "稳定通勤者", profile: { preference: "直达公交" } },
        { publicId: `per_flexible_${suffix}`, name: "弹性通勤者", profile: { preference: "动态改道" } },
      ],
      study: {
        brief: "研究雨天通勤决策",
        studyType: "user_research",
        framework: "Jobs to be Done",
        methods: ["Interview Chat"],
        audience: "城市公共交通通勤者",
        personaCount: 2,
        workflowType: "batch_research",
        workflowVersion: "research-dag-v3-dynamic",
        taskGraph: [
          { key: "interviews", title: "访谈", toolName: "run_interviews", dependsOn: [] },
          { key: "report", title: "报告", toolName: "generate_report", dependsOn: ["interviews"] },
        ],
      },
    };
    const firstProposal = await database.transaction((transaction) => proposeStudyContextCandidates(transaction, proposalInput));
    const repeatedProposal = await database.transaction((transaction) => proposeStudyContextCandidates(transaction, proposalInput));
    const thirdProposal = await database.transaction((transaction) => proposeStudyContextCandidates(transaction, proposalInput));
    assert.equal(firstProposal.proposed, 7);
    assert.equal(repeatedProposal.proposed, 0);
    assert.equal(repeatedProposal.duplicates, 4);
    assert.equal(thirdProposal.proposed, 0);
    assert.equal(thirdProposal.duplicates, 4);
    assert.equal(firstProposal.knowledgeGapAssetPublicIds.length, 3);
    assert.equal(repeatedProposal.reportAssetPublicId, firstProposal.reportAssetPublicId);

    const approvedTemplate = await reviewContextAsset(viewer, firstProposal.templateAssetPublicId, {
      action: "approve",
      note: "方法、任务图和适用范围已复核",
    });
    assert.equal(typeof approvedTemplate, "object");
    const retrievedTemplate = await retrieveContext({
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: "Jobs to be Done Interview Chat research template",
      purpose: "intent_planning",
      limit: 10,
      audit: false,
    });
    assert(retrievedTemplate.citations.some((item) => item.assetPublicId === firstProposal.templateAssetPublicId));

    const resolvedGapPublicId = firstProposal.knowledgeGapAssetPublicIds[0];
    const approvedGap = await reviewContextAsset(viewer, resolvedGapPublicId, {
      action: "approve",
      note: "问题范围清晰，进入研究积压",
    });
    assert.equal(typeof approvedGap, "object");
    const resolution = await createContextEdge(viewer, resolvedGapPublicId, {
      targetPublicId: related.publicId,
      relation: "resolved_by",
      note: "方法说明补齐该问题的验证设计",
    });
    assert.equal(typeof resolution, "object");
    const resolvedGap = await database.query<{ status: string }>(
      "select status from context_assets where public_id = $1",
      [resolvedGapPublicId],
    );
    assert.equal(resolvedGap.rows[0].status, "archived");

    const expiredGapPublicId = firstProposal.knowledgeGapAssetPublicIds[1];
    await database.query(
      "update context_assets set retention_expires_at = now() - interval '1 day' where public_id = $1",
      [expiredGapPublicId],
    );
    const expiredApproval = await reviewContextAsset(viewer, expiredGapPublicId, {
      action: "approve",
      note: "不应通过",
    });
    assert.equal(expiredApproval, "expired");

    const persisted = await database.query<{
      status: string; review_status: string; ingestion_method: string; source_name: string;
      evidence_kind: string; consent_status: string; pii_status: string;
      source_hash: string; content_hash: string; versions: number; edges: number; events: number;
    }>(
      `select asset.status, asset.review_status, asset.ingestion_method, asset.source_name,
              asset.evidence_kind, asset.consent_status, asset.pii_status,
              asset.source_hash, version.content_hash,
              (select count(*)::int from context_asset_versions where asset_id = asset.id) as versions,
              (select count(*)::int from context_edges where from_asset_id = asset.id) as edges,
              (select count(*)::int from context_asset_events where asset_id = asset.id) as events
       from context_assets asset
       join context_asset_versions version on version.asset_id = asset.id and version.version = asset.current_version
       where asset.public_id = $1`,
      [pending.publicId],
    );
    assert.deepEqual(persisted.rows[0], {
      status: "archived",
      review_status: "rejected",
      ingestion_method: "file",
      source_name: `rainy-commute-${suffix}.md`,
      evidence_kind: "human",
      consent_status: "confirmed",
      pii_status: "redacted",
      source_hash: persisted.rows[0].content_hash,
      content_hash: persisted.rows[0].content_hash,
      versions: 2,
      edges: 1,
      events: 5,
    });
    assert.match(persisted.rows[0].content_hash, /^[0-9a-f]{64}$/);

    const proposalCounts = await database.query<{ assets: number; pending: number; persona_edges: number }>(
      `select
         count(*)::int as assets,
         count(*) filter (where review_status = 'pending' and status = 'draft')::int as pending,
         (select count(*)::int from context_edges edge
          join context_assets source on source.id = edge.from_asset_id
          join context_assets target on target.id = edge.to_asset_id
          where source.workspace_id = $1 and source.origin_kind = 'study_persona'
            and target.origin_kind = 'report' and edge.relation = 'derived_from') as persona_edges
       from context_assets
       where workspace_id = $1 and origin_public_id in ($2, $3, $4)`,
      [viewer.workspaceId, proposalInput.report.publicId, ...proposalInput.personas.map((item) => item.publicId)],
    );
    assert.deepEqual(proposalCounts.rows[0], { assets: 4, pending: 3, persona_edges: 2 });

    const governedCandidates = await database.query<{
      templates: number; gaps: number; dedupe_keys: number; duplicate_events: number;
      resolved_events: number; derived_edges: number;
    }>(
      `select
         count(*) filter (where asset_type = 'research_template')::int as templates,
         count(*) filter (where asset_type = 'knowledge_gap')::int as gaps,
         count(candidate_dedupe_key)::int as dedupe_keys,
         (select count(*)::int from context_asset_events event
          join context_assets candidate on candidate.id = event.asset_id
          where candidate.workspace_id = $1 and event.event_type = 'candidate.duplicate_detected') as duplicate_events,
         (select count(*)::int from context_asset_events event
          join context_assets candidate on candidate.id = event.asset_id
          where candidate.workspace_id = $1 and event.event_type = 'knowledge_gap.resolved') as resolved_events,
         (select count(*)::int from context_edges edge
          join context_assets candidate on candidate.id = edge.from_asset_id
          where candidate.workspace_id = $1
            and candidate.asset_type in ('research_template', 'knowledge_gap')
            and edge.relation = 'derived_from') as derived_edges
       from context_assets where workspace_id = $1
         and asset_type in ('research_template', 'knowledge_gap')`,
      [viewer.workspaceId],
    );
    assert.deepEqual(governedCandidates.rows[0], {
      templates: 1,
      gaps: 3,
      dedupe_keys: 4,
      duplicate_events: 4,
      resolved_events: 1,
      derived_edges: 4,
    });

    console.log(JSON.stringify({
      pendingExcluded: true,
      approvedRetrieved: true,
      newVersionRequiresReview: true,
      rejectedExcluded: true,
      provenanceAndHashesPersisted: true,
      relationCount: persisted.rows[0].edges,
      eventCount: persisted.rows[0].events,
      automaticProposals: firstProposal.proposed,
      repeatedProposals: repeatedProposal.proposed,
      thirdProposals: thirdProposal.proposed,
      duplicateCandidates: repeatedProposal.duplicates,
      approvedTemplateRetrieved: true,
      resolvedKnowledgeGapArchived: true,
      expiredKnowledgeGapRejected: true,
      governedCandidates: governedCandidates.rows[0],
      personaEdges: proposalCounts.rows[0].persona_edges,
    }, null, 2));
  } finally {
    if (workspaceId) await database.query("delete from workspaces where id = $1", [workspaceId]);
    await database.query("delete from auth.users where id = $1", [authUserId]);
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
