import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { getStudyRunComparison } from "../src/lib/study-run-replay";
import { confirmStudyPlan } from "../src/lib/studies";

if (process.env.PLAN_VERSION_REPLAY_SMOKE_CONFIRM !== "1") {
  throw new Error("Set PLAN_VERSION_REPLAY_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Plan version replay smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

async function main() {
  const database = await getDatabase();
  try {
    const actor = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Plan replay smoke"}'::jsonb)`,
        [authUserId, `plan-replay-${suffix}@example.com`],
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
      displayName: "Plan replay smoke",
      email: `plan-replay-${suffix}@example.com`,
      workspaceId: actor.workspace_id,
      workspacePublicId: actor.workspace_public_id,
      workspaceName: "Plan replay smoke",
      role: "owner" as const,
      tokenBalance: 0,
    };
    const studyPublicId = `std_plan_${suffix}`;
    const study = await database.query<{ id: string }>(
      `insert into studies (
         public_id, workspace_id, created_by, title, brief, study_type,
         status, current_stage, estimated_tokens
       ) values ($1, $2, $3, 'Plan Version smoke', '比较两版通勤研究计划', 'user_research',
                 'awaiting_confirmation', 'confirmation', 12000)
       returning id::text as id`,
      [studyPublicId, viewer.workspaceId, viewer.userId],
    );
    const studyId = study.rows[0].id;
    await database.query(
      `insert into study_plans (
         study_id, version, framework, methods, persona_filters, persona_count,
         estimated_duration_minutes, estimated_tokens, source, prompt_version, rationale
       ) values ($1, 1, 'JTBD', '["Interview Chat"]'::jsonb,
                 '{"audience":"城市通勤者","source":"公开资料"}'::jsonb,
                 6, 30, 12000, 'local_rules', 'plan-smoke-v1', '先理解通勤决策路径。')`,
      [studyId],
    );

    assert.equal(await confirmStudyPlan(viewer, studyPublicId), "confirmed");
    const firstRun = await database.query<{ id: string; public_id: string; plan_public_id: string }>(
      `select run.id::text as id, run.public_id, plan.public_id as plan_public_id
       from study_runs run join study_plan_versions plan on plan.id = run.plan_version_id
       where run.study_id = $1 order by run.created_at, run.id limit 1`,
      [studyId],
    );

    async function seedRun(runId: string, variant: 1 | 2) {
      const task = await database.query<{ id: string }>(
        `insert into study_tasks (
           public_id, study_id, run_id, position, task_key, title, tool_name,
           status, origin, generation, attempt, output, started_at, finished_at
         ) values ($1, $2, $3, 0, $4, $5, $6, 'completed', $7, $8, $9, $10::jsonb,
                   now() - interval '2 minutes', now() - interval '1 minute')
         returning id::text as id`,
        [
          `tsk_${variant}_${suffix}`, studyId, runId, variant === 1 ? "baseline" : "validation",
          variant === 1 ? "基准扫描" : "追加验证", variant === 1 ? "scoutCategoryTrends" : "validateDirections",
          variant === 1 ? "planned" : "dynamic", variant === 1 ? 0 : 1, variant,
          JSON.stringify({ variant, result: "ok" }),
        ],
      );
      await database.query(
        `insert into study_tool_invocations (
           public_id, study_id, run_id, task_id, tool_name, idempotency_key,
           status, arguments, result, skill_slug, skill_version, finished_at
         ) values ($1, $2, $3, $4, $5, $6, 'completed', '{}'::jsonb, '{"ok":true}'::jsonb,
                   $7, $8, now())`,
        [`inv_${variant}_${suffix}`, studyId, runId, task.rows[0].id, variant === 1 ? "scoutCategoryTrends" : "validateDirections", `plan-replay-${variant}-${suffix}`, variant === 1 ? "scout-research" : "validate-directions", variant,],
      );
      await database.query(
        `insert into study_artifacts (public_id, study_id, run_id, task_id, artifact_type, title, content)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [`art_${variant}_${suffix}`, studyId, runId, task.rows[0].id, variant === 1 ? "public_sources" : "direction_validation", variant === 1 ? "基准证据" : "验证结果", JSON.stringify({ variant })],
      );
      await database.query(
        `insert into study_run_checkpoints (run_id, study_id, cursor, state)
         values ($1, $2, 1, $3::jsonb)`,
        [runId, studyId, JSON.stringify({ variant, complete: true })],
      );
      await database.query(
        `insert into context_retrievals (
           public_id, workspace_id, created_by, study_id, run_id, query, strategy,
           embedding_model, embedding_version, lexical_weight, semantic_weight
         ) values ($1, $2, $3, $4, $5, '通勤决策', $6, $7, $8, $9, $10)`,
        [
          `cxr_${variant}_${suffix}`, viewer.workspaceId, viewer.userId, studyId, runId,
          variant === 1 ? "lexical_metadata_v1" : "hybrid_v1",
          variant === 1 ? null : "hash-ngram-128", variant === 1 ? null : "v1",
          variant === 1 ? null : 0.7, variant === 1 ? null : 0.3,
        ],
      );
      await database.query(
        `insert into study_events (study_id, run_id, event_type, payload)
         values ($1, $2, 'run.started', $3::jsonb), ($1, $2, 'run.completed', $3::jsonb)`,
        [studyId, runId, JSON.stringify({ variant })],
      );
      if (variant === 2) {
        await database.query(
          `insert into reasoning_decisions (
             public_id, workspace_id, study_id, run_id, decision_key, sequence,
             policy_version, chosen_action, reason
           ) values ($1, $2, $3, $4, 'append-validation', 0, 'deterministic-research-v2',
                     '{"type":"append_task"}'::jsonb, '证据覆盖不足，追加验证任务。')`,
          [`rsd_${suffix}`, viewer.workspaceId, studyId, runId],
        );
      }
      await database.query(
        `update study_runs set status = 'completed', provider = 'smoke', provider_model = $2,
                prompt_version = $3, workflow_version = $4, strategy_key = $5,
                strategy_version = $6, reasoning_policy_version = $7,
                usage = $8::jsonb, started_at = now() - interval '3 minutes', finished_at = now()
         where id = $1`,
        [runId, `smoke-model-${variant}`, `run-prompt-v${variant}`, `research-dag-v${variant + 2}`, variant === 1 ? "baseline" : "validation", `v${variant}`, `deterministic-research-v${variant}`, JSON.stringify({ total_tokens: variant * 1000 })],
      );
    }

    await seedRun(firstRun.rows[0].id, 1);
    await database.query(
      `update study_plans set version = 2, status = 'draft', current_plan_version_id = null,
              framework = 'Double Diamond', methods = '["Scout Agent","Interview Chat"]'::jsonb,
              persona_count = 8, estimated_tokens = 18000, prompt_version = 'plan-smoke-v2',
              rationale = '增加公开观察与方向验证。', confirmed_at = null, updated_at = now()
       where study_id = $1`,
      [studyId],
    );
    assert.equal(await confirmStudyPlan(viewer, studyPublicId), "confirmed");
    const secondRun = await database.query<{ id: string; public_id: string; plan_public_id: string }>(
      `select run.id::text as id, run.public_id, plan.public_id as plan_public_id
       from study_runs run join study_plan_versions plan on plan.id = run.plan_version_id
       where run.study_id = $1 order by run.created_at desc, run.id desc limit 1`,
      [studyId],
    );
    await seedRun(secondRun.rows[0].id, 2);

    assert.notEqual(firstRun.rows[0].plan_public_id, secondRun.rows[0].plan_public_id);
    await assert.rejects(
      database.query("update study_plan_versions set rationale = 'mutated' where public_id = $1", [firstRun.rows[0].plan_public_id]),
      /immutable/,
    );
    const comparison = await getStudyRunComparison(viewer, studyPublicId, firstRun.rows[0].public_id, secondRun.rows[0].public_id);
    assert(comparison?.left && comparison.right);
    assert.equal(comparison.left.planVersion, 1);
    assert.equal(comparison.right.planVersion, 2);
    assert.notEqual(comparison.left.plan.contentHash, comparison.right.plan.contentHash);
    assert.equal(comparison.left.context?.strategy, "lexical_metadata_v1");
    assert.equal(comparison.right.context?.strategy, "hybrid_v1");
    assert.equal(comparison.right.counts.dynamicTasks, 1);
    assert.equal(comparison.right.decisions[0]?.action, "append_task");
    assert(comparison.differences.includes("研究计划"));
    assert(comparison.differences.includes("任务图"));
    assert.equal(await getStudyRunComparison({ ...viewer, workspaceId: "999999999" }, studyPublicId), null);

    console.log(JSON.stringify({
      planVersions: [comparison.left.planVersionPublicId, comparison.right.planVersionPublicId],
      runPublicIds: [comparison.left.publicId, comparison.right.publicId],
      differences: comparison.differences,
      immutable: true,
      crossWorkspaceHidden: true,
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
