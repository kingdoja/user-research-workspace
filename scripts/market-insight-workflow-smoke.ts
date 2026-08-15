import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { assignActiveStrategy } from "../src/lib/runtime-control";
import { confirmStudyPlan, createStudy, getStudy, submitStudyClarification } from "../src/lib/studies";
import { getStudyRunComparison } from "../src/lib/study-run-replay";

if (process.env.MARKET_INSIGHT_WORKFLOW_SMOKE_CONFIRM !== "1") {
  throw new Error("Set MARKET_INSIGHT_WORKFLOW_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Market insight workflow smoke test only runs against a local database.");
}
process.env.OPENAI_API_KEY = "";

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID()];
const workspaceIds: string[] = [];

async function answerClarification(viewer: Parameters<typeof submitStudyClarification>[0], studyPublicId: string) {
  const database = await getDatabase();
  const result = await database.query<{ payload: { questions?: Array<{ id: string; options: string[] }> } | string }>(
    `select event.payload
     from study_events event
     join studies study on study.id = event.study_id
     where study.public_id = $1 and event.event_type = 'clarification.requested'
     order by event.created_at desc, event.id desc limit 1`,
    [studyPublicId],
  );
  const payload: { questions?: Array<{ id: string; options: string[] }> } = typeof result.rows[0].payload === "string"
    ? JSON.parse(result.rows[0].payload)
    : result.rows[0].payload;
  const questions = payload.questions ?? [];
  assert(questions.length > 0);
  const status = await submitStudyClarification(viewer, studyPublicId, questions.map((question) => ({
    questionId: question.id,
    selected: [question.options[0]],
  })));
  assert.equal(status, "completed");
}

async function main() {
  const database = await getDatabase();
  try {
    const actors = await database.transaction(async (transaction) => {
      for (const [index, authUserId] of authUserIds.entries()) {
        await transaction.query(
          `insert into auth.users (id, email, raw_user_meta_data)
           values ($1, $2, $3::jsonb)`,
          [authUserId, `market-insight-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `Market insight smoke ${index}` })],
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
      displayName: "Market insight owner",
      email: `market-insight-0-${suffix}@example.com`,
      workspaceId: actors[0].workspace_id,
      workspacePublicId: actors[0].workspace_public_id,
      workspaceName: "Market insight workspace",
      role: "owner" as const,
      tokenBalance: 0,
    };
    const otherViewer = {
      ...viewer,
      userId: actors[1].user_id,
      userPublicId: actors[1].user_public_id,
      workspaceId: actors[1].workspace_id,
      workspacePublicId: actors[1].workspace_public_id,
      email: `market-insight-1-${suffix}@example.com`,
    };

    const researchPublicId = await createStudy(
      viewer,
      `研究咖啡订阅 ${suffix} 用户的留存动机与取消路径，支持产品优先级决策。`,
    );
    const marketPublicId = await createStudy(
      viewer,
      `分析咖啡订阅 ${suffix} 市场格局、竞争信号、增长驱动与未来进入机会。`,
      "market_insight",
    );
    await answerClarification(viewer, researchPublicId);
    await answerClarification(viewer, marketPublicId);
    assert.equal(await confirmStudyPlan(viewer, researchPublicId), "confirmed");
    assert.equal(await confirmStudyPlan(viewer, marketPublicId), "confirmed");
    assert.equal(await confirmStudyPlan(viewer, marketPublicId), "already_confirmed");

    const contracts = await database.query<{
      study_public_id: string; product_line: string; intent_product_line: string; plan_product_line: string;
      workflow_type: string; template_key: string; template_version: string; task_graph: unknown[] | string;
      output_contracts: string[] | string; content_hash: string; run_workflow_type: string;
      run_workflow_version: string; run_id: string; study_id: string; intent_id: string;
      plan_id: string; workflow_id: string; run_intent_id: string; run_plan_id: string; run_workflow_id: string;
    }>(
      `select study.public_id as study_public_id, study.product_line,
              intent.product_line as intent_product_line, plan.product_line as plan_product_line,
              workflow.workflow_type, workflow.template_key, workflow.template_version,
              workflow.task_graph, workflow.output_contracts, workflow.content_hash,
              run.workflow_type as run_workflow_type, run.workflow_version as run_workflow_version,
              run.id::text as run_id, study.id::text as study_id, intent.id::text as intent_id,
              plan.id::text as plan_id, workflow.id::text as workflow_id,
              run.intent_version_id::text as run_intent_id, run.plan_version_id::text as run_plan_id,
              run.workflow_definition_id::text as run_workflow_id
       from studies study
       join study_runs run on run.study_id = study.id
       join study_intent_versions intent on intent.id = run.intent_version_id
       join study_plan_versions plan on plan.id = run.plan_version_id
       join workflow_definitions workflow on workflow.id = run.workflow_definition_id
       where study.public_id = any($1::text[])
       order by study.product_line`,
      [[researchPublicId, marketPublicId]],
    );
    assert.equal(contracts.rows.length, 2);
    const market = contracts.rows.find((row) => row.product_line === "market_insight");
    const research = contracts.rows.find((row) => row.product_line === "research");
    assert(market && research);
    assert.equal(research.workflow_type, "batch_research");
    assert.equal(research.template_key, "research_dag");
    assert.equal(market.intent_product_line, "market_insight");
    assert.equal(market.plan_product_line, "market_insight");
    assert.equal(market.workflow_type, "market_insight");
    assert.equal(market.template_key, "market_insight_dag");
    assert.equal(market.template_version, "market-insight-dag-v1");
    assert.equal(market.run_workflow_type, market.workflow_type);
    assert.equal(market.run_workflow_version, market.template_version);
    assert.equal(market.run_intent_id, market.intent_id);
    assert.equal(market.run_plan_id, market.plan_id);
    assert.equal(market.run_workflow_id, market.workflow_id);
    assert.notEqual(market.content_hash, research.content_hash);

    const marketTasks = typeof market.task_graph === "string" ? JSON.parse(market.task_graph) : market.task_graph;
    const toolNames = marketTasks.map((task: { toolName: string }) => task.toolName);
    const forbiddenTools = [
      "searchPersonas", "buildPersona", "createPanel", "interviewChatBatchOne",
      "interviewChatBatchTwo", "audienceCall", "discussionChat",
    ];
    assert(toolNames.includes("designStudy"));
    assert(toolNames.includes("deepResearch"));
    assert(toolNames.includes("generateReport"));
    assert(!forbiddenTools.some((tool) => toolNames.includes(tool)));
    const outputs = typeof market.output_contracts === "string" ? JSON.parse(market.output_contracts) : market.output_contracts;
    assert.deepEqual(outputs, ["market_landscape", "opportunity_map", "competitive_signals", "evidence", "report"]);

    const intentContexts = await database.query<{ purpose: string; product_line: string }>(
      `select retrieval.purpose, intent.product_line
       from study_intent_versions intent
       join context_retrievals retrieval on retrieval.id = intent.context_retrieval_id
       join studies study on study.id = intent.study_id
       where study.public_id = $1`,
      [marketPublicId],
    );
    assert(intentContexts.rows.length >= 2);
    assert(intentContexts.rows.every((row) => row.purpose === "intent_planning" && row.product_line === "market_insight"));

    const strategy = await assignActiveStrategy({
      queryable: database,
      workspaceId: viewer.workspaceId,
      studyId: market.study_id,
      runId: market.run_id,
      subjectKey: `study:${marketPublicId}`,
      workflowType: "market_insight",
    });
    assert.equal(strategy.variantKey, "default");

    const detail = await getStudy(viewer, marketPublicId);
    assert.equal(detail?.productLine, "market_insight");
    assert.equal(detail?.intent?.productLine, "market_insight");
    assert.equal(detail?.workflow?.workflowType, "market_insight");
    const replay = await getStudyRunComparison(viewer, marketPublicId);
    assert.equal(replay?.right?.plan.productLine, "market_insight");
    assert.equal(replay?.right?.versions.workflowType, "market_insight");
    assert.equal(await getStudy(otherViewer, marketPublicId), null);
    assert.equal(await getStudyRunComparison(otherViewer, marketPublicId), null);
    await assert.rejects(
      database.query("update workflow_definitions set template_version = 'mutated' where id = $1", [market.workflow_id]),
      /immutable/,
    );

    console.log(JSON.stringify({
      researchWorkflow: `${research.workflow_type}@${research.template_version}`,
      marketInsightWorkflow: `${market.workflow_type}@${market.template_version}`,
      marketInsightTaskTools: toolNames,
      marketInsightOutputs: outputs,
      sharedContractBindings: true,
      intentPlanningContextBound: true,
      immutableWorkflow: true,
      idempotentConfirmation: true,
      crossWorkspaceHidden: true,
      replayIdentityLocked: true,
      strategyAssignmentSupported: true,
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
