import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createAgentEvalSuite,
  labelAgentEvalCase,
  listAgentEvalSuites,
  runAgentEvalSuite,
} from "../src/lib/agent-evals";
import {
  createContextAsset,
  retrieveContext,
  retrieveContextForReasoningDecision,
  reviewContextAsset,
} from "../src/lib/context-system";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { evaluateContextRefreshDecision, evaluateReasoningCheckpoint } from "../src/lib/reasoning-runtime";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.AGENT_EVAL_DYNAMIC_CONTEXT_SMOKE_CONFIRM !== "1") {
  throw new Error("Set AGENT_EVAL_DYNAMIC_CONTEXT_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Agent Eval dynamic Context smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

async function main() {
  const database = await getDatabase();
  try {
    const seeded = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Agent eval smoke"}'::jsonb)`,
        [authUserId, `agent-eval-${suffix}@example.com`],
      );
      const actor = await transaction.query<{
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
      workspaceId = actor.rows[0].workspace_id;
      const study = await transaction.query<{ id: string }>(
        `insert into studies (public_id, workspace_id, created_by, title, brief, status, current_stage)
         values ($1, $2, $3, 'Trusted loop smoke', '验证 Eval 与动态 Context', 'running', 'execution')
         returning id::text as id`,
        [`std_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const planVersion = await createSmokePlanVersion(transaction, study.rows[0].id, actor.rows[0].user_id);
      const run = await transaction.query<{ id: string }>(
        `insert into study_runs (study_id, plan_version_id, status, provider, provider_model, started_at)
         values ($1, $2, 'running', 'smoke', 'smoke-model', now()) returning id::text as id`,
        [study.rows[0].id, planVersion.id],
      );
      await transaction.query(
        `insert into study_tasks (public_id, study_id, run_id, position, task_key, title, tool_name, status, depends_on, output, finished_at)
         values ($1, $2, $3, 0, 'research', 'Research', 'deepResearch', 'completed', '[]'::jsonb,
                 '{"sources":[{"url":"https://evidence.example.com"}],"usage":{"total_tokens":1}}'::jsonb, now()),
                ($4, $2, $3, 1, 'report', 'Report', 'generateReport', 'pending', '["research"]'::jsonb, '{}'::jsonb, null)`,
        [`tsk_research_${suffix}`, study.rows[0].id, run.rows[0].id, `tsk_report_${suffix}`],
      );
      const personas = await transaction.query<{ id: string; public_id: string }>(
        `insert into study_personas (
           public_id, study_id, run_id, workspace_id, created_by, name, archetype, profile,
           evidence_status, evidence_confidence, retention_status
         ) values
           ($1, $2, $3, $4, $5, '谨慎决策者', 'careful', '{"preference":"证据"}'::jsonb, 'human_grounded', 'high', 'retained'),
           ($6, $2, $3, $4, $5, '快速尝试者', 'fast', '{"preference":"速度"}'::jsonb, 'human_grounded', 'high', 'retained')
         returning id::text as id, public_id`,
        [`per_a_${suffix}`, study.rows[0].id, run.rows[0].id, workspaceId, actor.rows[0].user_id, `per_b_${suffix}`],
      );
      return { actor: actor.rows[0], studyId: study.rows[0].id, runId: run.rows[0].id, personas: personas.rows };
    });
    const viewer = {
      userId: seeded.actor.user_id,
      userPublicId: seeded.actor.user_public_id,
      displayName: "Agent eval smoke",
      email: `agent-eval-${suffix}@example.com`,
      workspaceId: seeded.actor.workspace_id,
      workspacePublicId: seeded.actor.workspace_public_id,
      workspaceName: "Agent eval smoke",
      role: "owner" as const,
      tokenBalance: 0,
    };
    const pendingAsset = await createContextAsset(viewer, {
      assetType: "research_sample", scope: "workspace", studyPublicId: null,
      title: "经授权的访谈样本", description: "动态 Context 与 Eval 的可信源",
      sourceUri: null, content: `受访者样本 ${suffix}，偏好证据可追溯的推荐。`, changeNote: "smoke",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "human", consentStatus: "confirmed", piiStatus: "redacted",
      retentionExpiresAt: null, reviewStatus: "pending",
    });
    assert.equal(typeof pendingAsset, "object");
    if (typeof pendingAsset !== "object") throw new Error("CONTEXT_ASSET_CREATE_FAILED");
    const unauthorized = await createAgentEvalSuite(viewer, {
      suiteKey: `unauthorized-${suffix}`, name: "Unauthorized", description: "smoke", cases: [{
        caseKey: "citation", title: "Citation", trustDimension: "fabricated_citation", instruction: "cite",
        expected: { requiredCitationSourcePublicIds: [], minimumDistinctPersonaSources: 2 },
        sources: [{ sourceType: "context_asset_version", sourcePublicId: "cav_not_authorized" }],
      }],
    });
    assert.equal(unauthorized, "source_not_authorized");
    await reviewContextAsset(viewer, pendingAsset.publicId, { action: "approve", note: "smoke approval" });
    const assetVersion = await database.query<{ public_id: string }>(
      `select version.public_id from context_asset_versions version
       join context_assets asset on asset.id = version.asset_id
       where asset.public_id = $1 and version.version = asset.current_version`,
      [pendingAsset.publicId],
    );
    const suite = await createAgentEvalSuite(viewer, {
      suiteKey: `trusted-loop-${suffix}`, name: "可信研究回路", description: "smoke",
      cases: [
        {
          caseKey: "citation-grounding", title: "禁止伪造引用", trustDimension: "fabricated_citation", instruction: "引用已授权样本",
          expected: { requiredCitationSourcePublicIds: [assetVersion.rows[0].public_id], minimumDistinctPersonaSources: 2 },
          sources: [{ sourceType: "context_asset_version", sourcePublicId: assetVersion.rows[0].public_id }],
        },
        {
          caseKey: "persona-diversity", title: "禁止单 Persona 收敛", trustDimension: "persona_convergence", instruction: "比较不同 Persona",
          expected: { requiredCitationSourcePublicIds: [], minimumDistinctPersonaSources: 2 },
          sources: seeded.personas.map((persona) => ({ sourceType: "persona" as const, sourcePublicId: persona.public_id })),
        },
      ],
    });
    assert.equal(typeof suite, "object");
    if (typeof suite !== "object") throw new Error("AGENT_EVAL_SUITE_CREATE_FAILED");
    const cases = await database.query<{ public_id: string; case_key: string }>(
      `select evaluation_case.public_id, evaluation_case.case_key from agent_eval_cases evaluation_case
       join agent_eval_suites suite on suite.id = evaluation_case.suite_id where suite.public_id = $1 order by evaluation_case.id`,
      [suite.publicId],
    );
    const evaluation = await runAgentEvalSuite(viewer, suite.publicId, {
      outputs: [
        { casePublicId: cases.rows[0].public_id, summary: "错误引用", citedSourcePublicIds: ["cav_fabricated"], personaSourcePublicIds: [] },
        { casePublicId: cases.rows[1].public_id, summary: "单一 Persona", citedSourcePublicIds: [], personaSourcePublicIds: [seeded.personas[0].public_id] },
      ],
    });
    assert.equal(typeof evaluation, "object");
    if (typeof evaluation !== "object") throw new Error("AGENT_EVAL_RUN_FAILED");
    assert.equal(evaluation.failedCount, 2);
    const label = await labelAgentEvalCase(viewer, suite.publicId, { casePublicId: cases.rows[0].public_id, label: "needs_review", note: "人工复核伪造引用" });
    assert.equal(typeof label, "object");

    const initialContext = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId, studyId: seeded.studyId, runId: seeded.runId,
      query: "证据可追溯的推荐", purpose: "research_execution", limit: 8,
    });
    const checkpoint = await database.transaction((transaction) => evaluateReasoningCheckpoint(transaction, {
      workspaceId: viewer.workspaceId, studyId: seeded.studyId, runId: seeded.runId,
      strategyConfig: { minEvidenceSources: 1, minEvidenceDomains: 1 }, tokenBudget: 1000,
    }));
    const refresh = await database.transaction((transaction) => evaluateContextRefreshDecision(transaction, {
      workspaceId: viewer.workspaceId, studyId: seeded.studyId, runId: seeded.runId,
      checkpointDecisionPublicId: checkpoint.publicId, contextCitationCount: initialContext.citations.length,
      contextRetrievedAt: "2000-01-01T00:00:00.000Z", strategyConfig: { maxContextRefreshes: 1, contextRefreshMaxAgeMinutes: 1 },
    }));
    assert.equal(refresh.chosenAction, "refresh_context");
    assert.equal(refresh.triggerType, "stale");
    const dynamicContext = await database.transaction((transaction) => retrieveContextForReasoningDecision(transaction, {
      workspaceId: viewer.workspaceId, userId: viewer.userId, studyId: seeded.studyId, runId: seeded.runId,
      taskId: refresh.targetTaskId, reasoningDecisionPublicId: refresh.publicId, triggerType: "stale",
      triggerReason: refresh.reason, query: "证据可追溯的推荐\n下一任务：report", purpose: "research_execution", limit: 8,
    }));
    const replayedContext = await database.transaction((transaction) => retrieveContextForReasoningDecision(transaction, {
      workspaceId: viewer.workspaceId, userId: viewer.userId, studyId: seeded.studyId, runId: seeded.runId,
      taskId: refresh.targetTaskId, reasoningDecisionPublicId: refresh.publicId, triggerType: "stale",
      triggerReason: refresh.reason, query: "ignored on replay", purpose: "research_execution", limit: 8,
    }));
    assert.notEqual(dynamicContext.retrievalPublicId, initialContext.retrievalPublicId);
    assert.equal(replayedContext.retrievalPublicId, dynamicContext.retrievalPublicId);
    const resumedContext = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId, studyId: seeded.studyId, runId: seeded.runId,
      query: "ignored on resume", purpose: "research_execution", limit: 8,
    });
    assert.equal(resumedContext.retrievalPublicId, dynamicContext.retrievalPublicId);
    const listed = await listAgentEvalSuites(viewer);
    assert.equal(listed[0]?.publicId, suite.publicId);
    assert.equal(listed[0]?.latestRun?.failedCount, 2);
    const audit = await database.query<{ bindings: number; human_labels: number; results: number }>(
      `select
         (select count(*)::int from context_retrieval_bindings where run_id = $1) as bindings,
         (select count(*)::int from agent_eval_case_labels where workspace_id = $2) as human_labels,
         (select count(*)::int from agent_eval_results result join agent_eval_runs run on run.id = result.evaluation_run_id where run.workspace_id = $2) as results`,
      [seeded.runId, viewer.workspaceId],
    );
    assert.deepEqual(audit.rows[0], { bindings: 1, human_labels: 1, results: 2 });
    console.log(JSON.stringify({ unauthorizedSourceRejected: true, failedTrustCases: evaluation.failedCount, humanLabelSeparate: true, dynamicContextReplay: replayedContext.retrievalPublicId, bindings: audit.rows[0].bindings }, null, 2));
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
