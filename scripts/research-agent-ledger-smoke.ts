import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  appendResearchAgentDynamicTasks,
  pauseResearchAgentForInput,
  type ResearchToolName,
} from "../src/lib/research-harness";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.RESEARCH_AGENT_LEDGER_SMOKE_CONFIRM !== "1") {
  throw new Error("Set RESEARCH_AGENT_LEDGER_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Research Agent ledger smoke test only runs against a local database.");
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
         values ($1, $2, '{"display_name":"Agent Ledger Smoke"}'::jsonb)`,
        [authUserId, `agent-ledger-${suffix}@example.com`],
      );
      const actor = await transaction.query<{ user_id: string; user_public_id: string; workspace_id: string }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id
         from users app_user join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceId = actor.rows[0].workspace_id;
      const study = await transaction.query<{ id: string }>(
        `insert into studies (public_id, workspace_id, created_by, title, brief, status, current_stage)
         values ($1, $2, $3, 'Agent ledger smoke', 'Verify governed dynamic tasks', 'running', 'execution')
         returning id::text as id`,
        [`std_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const planVersion = await createSmokePlanVersion(transaction, study.rows[0].id, actor.rows[0].user_id);
      const run = await transaction.query<{ id: string }>(
        `insert into study_runs (study_id, plan_version_id, status, provider, provider_model, started_at)
         values ($1, $2, 'running', 'smoke', 'smoke-model', now()) returning id::text as id`,
        [study.rows[0].id, planVersion.id],
      );
      const tasks: Array<{
        key: string;
        title: string;
        tool: ResearchToolName;
        status: "completed" | "pending";
        dependencies: string[];
      }> = [
        { key: "design", title: "Design", tool: "designStudy", status: "completed", dependencies: [] },
        { key: "research", title: "Research", tool: "deepResearch", status: "completed", dependencies: ["design"] },
        { key: "report", title: "Report", tool: "generateReport", status: "pending", dependencies: ["research"] },
      ];
      const storedTasks = [];
      for (const [position, task] of tasks.entries()) {
        const inserted = await transaction.query<{ id: string; public_id: string }>(
          `insert into study_tasks (
             public_id, study_id, run_id, position, task_key, title, tool_name, status,
             depends_on, input, output, finished_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '{}'::jsonb, '{}'::jsonb,
                     case when $8 = 'completed' then now() else null end)
           returning id::text as id, public_id`,
          [`tsk_${position}_${suffix}`, study.rows[0].id, run.rows[0].id, position, task.key, task.title, task.tool, task.status, JSON.stringify(task.dependencies)],
        );
        storedTasks.push({
          id: inserted.rows[0].id,
          publicId: inserted.rows[0].public_id,
          position,
          key: task.key,
          title: task.title,
          toolName: task.tool,
          status: task.status,
          dependsOn: task.dependencies,
          input: {},
          output: {},
          attempt: 0,
          maxAttempts: 3,
          nextAttemptAt: null,
          waitingReason: null,
          timeoutSeconds: 300,
          origin: "planned" as const,
          generation: 0,
        });
      }
      return {
        userId: actor.rows[0].user_id,
        userPublicId: actor.rows[0].user_public_id,
        studyId: study.rows[0].id,
        runId: run.rows[0].id,
        tasks: storedTasks,
      };
    });

    const study = {
      studyId: seeded.studyId,
      publicId: `std_${suffix}`,
      workspaceId: workspaceId!,
      createdBy: seeded.userId,
      userPublicId: seeded.userPublicId,
      runId: seeded.runId,
      runStatus: "running",
      runStartedAt: new Date().toISOString(),
      brief: "Verify governed dynamic tasks",
      studyType: "standard",
      framework: "Smoke Framework",
      methods: ["Scout Agent" as const],
      audience: "Smoke audience",
      personaCount: 1,
      estimatedTokens: 1000,
      workflowType: "batch_research" as const,
      workflowVersion: "smoke-v1",
      workflowTaskGraph: null,
    };
    const strategy = {
      assignmentId: null,
      assignmentPublicId: null,
      experimentKey: null,
      variantKey: "smoke",
      strategyVersion: "smoke-v1",
      config: { maxDynamicTasks: 1 },
    };
    const appended = await appendResearchAgentDynamicTasks({
      database,
      study,
      tasks: seeded.tasks,
      strategy,
      decision: { responseId: `resp_append_${suffix}`, model: "smoke-model", promptVersion: "research-agent-controller-v2" },
      action: {
        type: "replan",
        summary: "Add counterevidence research.",
        reason: "The current evidence lacks constraints.",
        requestedTasks: [{
          key: "research_counterevidence",
          title: "Counterevidence research",
          toolName: "deepResearch",
          dependsOn: ["design"],
          input: { focus: "Find counterexamples and constraints" },
        }],
      },
    });
    assert.equal(appended.accepted, true);

    const ledger = await database.query<{
      id: string; public_id: string; position: number; task_key: string; title: string;
      status: "pending" | "running" | "completed" | "failed" | "skipped" | "waiting_input";
      depends_on: string[]; input: Record<string, unknown>; output: Record<string, unknown>;
      attempt: number; max_attempts: number; next_attempt_at: string | null; waiting_reason: string | null;
      timeout_seconds: number; origin: "planned" | "dynamic"; generation: number; tool_name: ResearchToolName;
      reasoning_decision_id: string | null;
    }>(
      `select id::text as id, public_id, position, task_key, title, tool_name, status, depends_on,
              input, output, attempt, max_attempts, next_attempt_at, waiting_reason, timeout_seconds,
              origin, generation, reasoning_decision_id::text as reasoning_decision_id
       from study_tasks where run_id = $1 order by position`,
      [seeded.runId],
    );
    const dynamicTask = ledger.rows.find((task) => task.task_key === "research_counterevidence");
    const reportTask = ledger.rows.find((task) => task.task_key === "report");
    assert(dynamicTask);
    assert(reportTask);
    assert.equal(dynamicTask.origin, "dynamic");
    assert(dynamicTask.reasoning_decision_id);
    assert.equal(dynamicTask.position, 2);
    assert.equal(reportTask.position, 3);
    assert(reportTask.depends_on.includes(dynamicTask.task_key));

    const agentDecision = await database.query<{ trigger_type: string; action_type: string; task_count: number }>(
      `select decision.trigger_type, candidate.action_type,
              count(task.id)::int as task_count
       from reasoning_decisions decision
       join reasoning_decision_candidates candidate on candidate.decision_id = decision.id and candidate.selected
       left join study_tasks task on task.reasoning_decision_id = decision.id
       where decision.id = $1
       group by decision.id, candidate.id`,
      [dynamicTask.reasoning_decision_id],
    );
    assert.deepEqual(agentDecision.rows[0], { trigger_type: "agent_controller", action_type: "replan", task_count: 1 });

    const binding = await database.query<{ count: number }>(
      "select count(*)::int as count from study_run_skill_bindings where run_id = $1 and skill_slug = 'deepResearch'",
      [seeded.runId],
    );
    assert.equal(binding.rows[0].count, 1);

    const limited = await appendResearchAgentDynamicTasks({
      database,
      study,
      // Deliberately use the stale pre-mutation snapshot. The transaction-level
      // quota check must still reject this request after locking the run.
      tasks: seeded.tasks,
      strategy,
      decision: { responseId: `resp_limited_${suffix}`, model: "smoke-model", promptVersion: "research-agent-controller-v2" },
      action: {
        type: "replan",
        summary: "Add another task.",
        reason: "Smoke limit check.",
        requestedTasks: [{ key: "research_extra", title: "Extra research", toolName: "deepResearch", dependsOn: ["design"], input: {} }],
      },
    });
    assert.equal(limited.accepted, false);
    assert.equal(limited.reason, "dynamic_task_limit_reached");

    await pauseResearchAgentForInput({
      database,
      study,
      task: {
        id: dynamicTask.id,
        publicId: dynamicTask.public_id,
        position: dynamicTask.position,
        key: dynamicTask.task_key,
        title: dynamicTask.title,
        toolName: "deepResearch",
        status: "pending",
        dependsOn: dynamicTask.depends_on,
        input: dynamicTask.input,
        output: dynamicTask.output,
        attempt: dynamicTask.attempt,
        maxAttempts: dynamicTask.max_attempts,
        nextAttemptAt: dynamicTask.next_attempt_at,
        waitingReason: dynamicTask.waiting_reason,
        timeoutSeconds: dynamicTask.timeout_seconds,
        origin: dynamicTask.origin,
        generation: dynamicTask.generation,
      },
      action: {
        type: "ask_user",
        summary: "Need a trusted source.",
        taskKey: dynamicTask.task_key,
        question: "Provide a trusted public source or narrow the scope.",
        options: ["Provide source", "Narrow scope"],
        fields: [{ key: "selectedOption", label: "Next step", type: "choice", required: true, options: ["Provide source", "Narrow scope"] }],
      },
    });
    const waiting = await database.query<{ task_status: string; run_status: string; input_count: number; event_count: number }>(
      `select
         (select status from study_tasks where id = $1) task_status,
         (select status from study_runs where id = $2) run_status,
         (select count(*)::int from study_task_inputs where task_id = $1 and status = 'pending') input_count,
         (select count(*)::int from study_events where run_id = $2 and event_type = 'agent.run.waiting_input') event_count`,
      [dynamicTask.id, seeded.runId],
    );
    assert.deepEqual(waiting.rows[0], { task_status: "waiting_input", run_status: "waiting_input", input_count: 1, event_count: 1 });
    console.log(JSON.stringify({ appended: appended.taskKeys, limited: limited.reason, waiting: waiting.rows[0] }, null, 2));
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
