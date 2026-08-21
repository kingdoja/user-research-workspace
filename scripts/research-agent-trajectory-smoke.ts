import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { evaluateResearchAgentTrajectory } from "../src/lib/research-agent-evaluation";
import { resolveResearchAgentRollout } from "../src/lib/research-agent-controller";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.RESEARCH_AGENT_TRAJECTORY_SMOKE_CONFIRM !== "1") throw new Error("Set RESEARCH_AGENT_TRAJECTORY_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) throw new Error("Trajectory smoke test only runs against a local database.");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

async function main() {
  const database = await getDatabase();
  try {
    const seeded = await database.transaction(async (transaction) => {
      await transaction.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}'::jsonb)`, [authUserId, `trajectory-${suffix}@example.com`]);
      const actor = await transaction.query<{ user_id: string; workspace_id: string }>(`select app_user.id::text as user_id, workspace.id::text as workspace_id from users app_user join workspace_members member on member.user_id = app_user.id join workspaces workspace on workspace.id = member.workspace_id where app_user.auth_user_id = $1`, [authUserId]);
      workspaceId = actor.rows[0].workspace_id;
      const study = await transaction.query<{ id: string }>(`insert into studies (public_id, workspace_id, created_by, title, brief, status, current_stage) values ($1, $2, $3, 'Trajectory smoke', 'Evaluate controller trajectory', 'completed', 'report') returning id::text as id`, [`std_${suffix}`, workspaceId, actor.rows[0].user_id]);
      const plan = await createSmokePlanVersion(transaction, study.rows[0].id, actor.rows[0].user_id);
      const run = await transaction.query<{ id: string }>(`insert into study_runs (study_id, plan_version_id, status, provider, provider_model, usage, started_at, finished_at) values ($1, $2, 'completed', 'smoke', 'smoke-model', '{"total_tokens":321}'::jsonb, now() - interval '4 seconds', now()) returning id::text as id`, [study.rows[0].id, plan.id]);
      await transaction.query(`insert into study_tasks (public_id, study_id, run_id, position, task_key, title, tool_name, status, origin, attempt, output) values ($1, $2, $3, 0, 'research', 'Research', 'deepResearch', 'completed', 'planned', 2, $4::jsonb), ($5, $2, $3, 1, 'report', 'Report', 'generateReport', 'completed', 'planned', 1, '{}'::jsonb)`, [`tsk_a_${suffix}`, study.rows[0].id, run.rows[0].id, '{"sources":[{"url":"https://one.example.com/a"},{"url":"https://two.example.net/b"}]}', `tsk_b_${suffix}`]);
      await transaction.query(`insert into study_events (study_id, run_id, event_type, payload, created_at) values ($1, $2, 'agent.turn.started', '{"turnId":"turn_1"}', now() - interval '3 seconds'), ($1, $2, 'agent.action.proposed', '{"action":{"type":"call_tool","taskKey":"research","toolName":"deepResearch"}}', now() - interval '2 seconds'), ($1, $2, 'dag.wave.started', '{"taskKeys":["research"]}', now() - interval '1 seconds'), ($1, $2, 'agent.turn.completed', '{"turnId":"turn_1"}', now() - interval '500 milliseconds'), ($1, $2, 'agent.action.rejected', '{"reason":"tool_not_allowed"}', now() - interval '400 milliseconds'), ($1, $2, 'run.tasks.recovered', '{}', now() - interval '300 milliseconds'), ($1, $2, 'agent.run.waiting_input', '{}', now() - interval '200 milliseconds')`, [study.rows[0].id, run.rows[0].id]);
      return { studyId: study.rows[0].id, runId: run.rows[0].id };
    });
    const evaluation = await evaluateResearchAgentTrajectory(database, {
      ...seeded,
      workspaceId: workspaceId!,
      controllerMode: "shadow",
      executionSource: "worker",
    });
    assert.equal(evaluation.metrics.executionSource, "worker");
    assert.equal(evaluation.metrics.decisionCount, 1);
    assert.equal(evaluation.metrics.policyRejectRate, 1);
    assert.equal(evaluation.metrics.callToolMatchRate, 1);
    assert.equal(evaluation.metrics.sourceCount, 2);
    assert.equal(evaluation.metrics.distinctDomainCount, 2);
    assert.equal(evaluation.metrics.retryCount, 1);
    assert.equal(evaluation.metrics.recoveryEventCount, 1);
    assert.equal(evaluation.metrics.humanInterventionCount, 1);
    const persisted = await database.query<{ count: number }>(`select count(*)::int as count from research_agent_trajectory_evaluations where run_id = $1`, [seeded.runId]);
    assert.equal(persisted.rows[0].count, 1);
    const activeRollout = await resolveResearchAgentRollout({
      queryable: database,
      workspaceId: workspaceId!,
      strategyKey: "default",
      strategyConfig: { agentControllerMode: "active", agentControllerShadowMinRuns: 1, agentControllerMaxRejectRate: 1 },
    });
    assert.equal(activeRollout.effectiveMode, "active");
    await database.query(
      `update research_agent_trajectory_evaluations
       set metrics = jsonb_set(metrics, '{templateMatchRate}', '0.5'::jsonb)
       where run_id = $1`,
      [seeded.runId],
    );
    const templateFallbackRollout = await resolveResearchAgentRollout({
      queryable: database,
      workspaceId: workspaceId!,
      strategyKey: "default",
      strategyConfig: { agentControllerMode: "active", agentControllerShadowMinRuns: 1, agentControllerMaxRejectRate: 1 },
    });
    assert.equal(templateFallbackRollout.effectiveMode, "shadow");
    assert.equal(templateFallbackRollout.reason, "shadow_template_match_rate_below_threshold");
    await database.query(
      `update research_agent_trajectory_evaluations
       set metrics = jsonb_set(metrics, '{controllerFailureRate}', '1'::jsonb)
       where run_id = $1`,
      [seeded.runId],
    );
    const fallbackRollout = await resolveResearchAgentRollout({
      queryable: database,
      workspaceId: workspaceId!,
      strategyKey: "default",
      strategyConfig: { agentControllerMode: "active", agentControllerShadowMinRuns: 1, agentControllerMaxRejectRate: 1 },
    });
    assert.equal(fallbackRollout.effectiveMode, "shadow");
    assert.equal(fallbackRollout.reason, "shadow_failure_rate_exceeded");
    console.log(JSON.stringify({ publicId: evaluation.publicId, metrics: evaluation.metrics, activeRollout, templateFallbackRollout, fallbackRollout }, null, 2));
  } finally {
    if (workspaceId) await database.query("delete from workspaces where id = $1", [workspaceId]);
    await database.query("delete from auth.users where id = $1", [authUserId]);
    await closeDatabase();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
