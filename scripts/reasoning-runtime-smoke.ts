import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { evaluateReasoningCheckpoint } from "../src/lib/reasoning-runtime";

if (process.env.REASONING_RUNTIME_SMOKE_CONFIRM !== "1") {
  throw new Error("Set REASONING_RUNTIME_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Reasoning runtime smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

function researchOutput(urls: string[], tokens: number) {
  return {
    queries: ["smoke query"],
    sources: urls.map((url, index) => ({ title: `Source ${index + 1}`, url, excerpt: "smoke" })),
    metadata: { primaryProvider: "tavily", fallbackUsed: false, seedSourceCount: 0, searchSourceCount: urls.length, finalSourceCount: urls.length },
    responseId: `resp_${suffix}`,
    model: "smoke-model",
    usage: { total_tokens: tokens },
  };
}

async function main() {
  const database = await getDatabase();
  try {
    const seeded = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Reasoning Smoke"}'::jsonb)`,
        [authUserId, `reasoning-${suffix}@example.com`],
      );
      const actor = await transaction.query<{ user_id: string; workspace_id: string }>(
        `select app_user.id::text as user_id, workspace.id::text as workspace_id
         from users app_user join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceId = actor.rows[0].workspace_id;
      const study = await transaction.query<{ id: string }>(
        `insert into studies (public_id, workspace_id, created_by, title, brief, status, current_stage)
         values ($1, $2, $3, 'Reasoning smoke', '验证动态任务决策', 'running', 'execution') returning id::text as id`,
        [`std_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const run = await transaction.query<{ id: string }>(
        `insert into study_runs (study_id, status, provider, provider_model, started_at)
         values ($1, 'running', 'smoke', 'smoke-model', now()) returning id::text as id`,
        [study.rows[0].id],
      );
      const tasks = [
        { key: "design", title: "设计", tool: "designStudy", status: "completed", dependencies: [], output: { framework: "smoke" } },
        { key: "research", title: "初始研究", tool: "deepResearch", status: "completed", dependencies: ["design"], output: researchOutput(["https://one.example.com/a", "https://one.example.com/b"], 1200) },
        { key: "persona_search", title: "Persona 检索", tool: "searchPersonas", status: "pending", dependencies: ["research"], output: {} },
        { key: "report", title: "报告", tool: "generateReport", status: "pending", dependencies: ["persona_search"], output: {} },
      ];
      for (const [position, task] of tasks.entries()) {
        await transaction.query(
          `insert into study_tasks (
             public_id, study_id, run_id, position, task_key, title, tool_name, status,
             depends_on, output, finished_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
                     case when $8 = 'completed' then now() else null end)`,
          [`tsk_${position}_${suffix}`, study.rows[0].id, run.rows[0].id, position, task.key, task.title, task.tool, task.status, JSON.stringify(task.dependencies), JSON.stringify(task.output)],
        );
      }
      return { studyId: study.rows[0].id, runId: run.rows[0].id };
    });

    const input = {
      workspaceId: workspaceId!,
      studyId: seeded.studyId,
      runId: seeded.runId,
      strategyConfig: { minEvidenceSources: 4, minEvidenceDomains: 2, maxDynamicTasks: 1, maxRunTokens: 10_000 },
      tokenBudget: 10_000,
      elapsedMs: 1000,
    };
    const first = await database.transaction((transaction) => evaluateReasoningCheckpoint(transaction, input));
    assert.equal(first.chosenAction, "append_task");
    assert.equal(first.appendedTaskKey, "research_dynamic_1");
    const replay = await database.transaction((transaction) => evaluateReasoningCheckpoint(transaction, input));
    assert.equal(replay.publicId, first.publicId);
    assert.equal(replay.reused, true);

    const dynamic = await database.query<{ id: string; position: number; origin: string; generation: number; depends_on: string[]; decision_public_id: string }>(
      `select task.id::text as id, task.position, task.origin, task.generation, task.depends_on,
              decision.public_id as decision_public_id
       from study_tasks task join reasoning_decisions decision on decision.id = task.reasoning_decision_id
       where task.run_id = $1 and task.task_key = 'research_dynamic_1'`,
      [seeded.runId],
    );
    assert.equal(dynamic.rows[0].origin, "dynamic");
    assert.equal(dynamic.rows[0].generation, 1);
    assert.equal(dynamic.rows[0].decision_public_id, first.publicId);
    const gate = await database.query<{ depends_on: string[] }>(
      "select depends_on from study_tasks where run_id = $1 and task_key = 'persona_search'",
      [seeded.runId],
    );
    assert(gate.rows[0].depends_on.includes("research_dynamic_1"));

    await database.query(
      `update study_tasks set status = 'completed', output = $3::jsonb, finished_at = now()
       where run_id = $1 and task_key = $2`,
      [seeded.runId, "research_dynamic_1", JSON.stringify(researchOutput(["https://two.example.net/a"], 900))],
    );
    const stopped = await database.transaction((transaction) => evaluateReasoningCheckpoint(transaction, input));
    assert.equal(stopped.chosenAction, "stop_expansion");

    await database.query(
      `update study_tasks set status = 'completed', output = '{}'::jsonb, finished_at = now()
       where run_id = $1 and task_key in ('persona_search', 'report')`,
      [seeded.runId],
    );
    const finished = await database.transaction((transaction) => evaluateReasoningCheckpoint(transaction, { ...input, triggerType: "terminal" }));
    assert.equal(finished.chosenAction, "finish_run");

    const counts = await database.query<{ decisions: number; candidates: number; dynamic_tasks: number; events: number }>(
      `select
         (select count(*)::int from reasoning_decisions where run_id = $1) decisions,
         (select count(*)::int from reasoning_decision_candidates candidate join reasoning_decisions decision on decision.id = candidate.decision_id where decision.run_id = $1) candidates,
         (select count(*)::int from study_tasks where run_id = $1 and origin = 'dynamic') dynamic_tasks,
         (select count(*)::int from study_events where run_id = $1 and event_type = 'reasoning.decision.recorded') events`,
      [seeded.runId],
    );
    assert.deepEqual(counts.rows[0], { decisions: 3, candidates: 12, dynamic_tasks: 1, events: 3 });
    console.log(JSON.stringify({ ...counts.rows[0], appendDecision: first.publicId, replayReused: true, stopped: stopped.reason, terminal: finished.reason }, null, 2));
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
