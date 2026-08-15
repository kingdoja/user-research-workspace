import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  classifyTaskError,
  recoverInterruptedTasks,
  startTaskAttempt,
  submitTaskInput,
  taskRetryDelaySeconds,
} from "../src/lib/task-recovery";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.TASK_RECOVERY_SMOKE_CONFIRM !== "1") {
  throw new Error("Set TASK_RECOVERY_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Task recovery smoke test only runs against a local database.");
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
         values ($1, $2, '{"display_name":"Task recovery smoke"}'::jsonb)`,
        [authUserId, `task-recovery-${suffix}@example.com`],
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
         values ($1, $2, $3, 'Task recovery smoke', '验证故障恢复', 'running', 'execution') returning id::text as id`,
        [`std_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const planVersion = await createSmokePlanVersion(transaction, study.rows[0].id, actor.rows[0].user_id);
      const run = await transaction.query<{ id: string }>(
        `insert into study_runs (study_id, plan_version_id, status, provider, provider_model, started_at)
         values ($1, $2, 'running', 'smoke', 'smoke-model', now()) returning id::text as id`,
        [study.rows[0].id, planVersion.id],
      );
      await transaction.query("insert into study_run_checkpoints (run_id, study_id, cursor, state) values ($1, $2, 1, '{\"completed\":{\"stable\":true}}')", [run.rows[0].id, study.rows[0].id]);
      return { userId: actor.rows[0].user_id, studyId: study.rows[0].id, runId: run.rows[0].id };
    });

    const createTask = async (key: string, status = "pending") => {
      const result = await database.query<{ id: string; public_id: string }>(
        `insert into study_tasks (public_id, study_id, run_id, position, task_key, title, tool_name, status, input, max_attempts)
         values ($1, $2, $3, (select count(*) from study_tasks where run_id = $3), $4, $4, 'deepResearch', $5, '{}'::jsonb, 3)
         returning id::text as id, public_id`,
        [`tsk_${key}_${suffix}`, seeded.studyId, seeded.runId, key, status],
      );
      return result.rows[0];
    };

    const retryTask = await createTask("retry");
    const first = await database.transaction((transaction) => startTaskAttempt(transaction, {
      studyId: seeded.studyId, runId: seeded.runId, taskId: retryTask.id, taskKey: "retry", toolName: "deepResearch",
      skillVersion: 1, contextRetrievalId: null, arguments: {},
    }));
    assert.equal(first.attempt, 1);
    assert.equal(taskRetryDelaySeconds(first.attempt), 2);
    assert.equal(classifyTaskError(new Error("RUNTIME_RATE_LIMITED")).disposition, "retry");
    await database.transaction(async (transaction) => {
      await transaction.query(
        `update study_task_attempts set status = 'failed', error_class = 'rate_limited', error_code = 'RUNTIME_RATE_LIMITED', retryable = true, finished_at = now()
         where task_id = $1 and attempt = 1`,
        [retryTask.id],
      );
      await transaction.query("update study_tool_invocations set status = 'failed', error_message = 'rate limited', finished_at = now() where id = $1", [first.invocationId]);
      await transaction.query("update study_tasks set status = 'pending', next_attempt_at = now() - interval '1 second', error_message = 'rate limited' where id = $1", [retryTask.id]);
    });
    const second = await database.transaction((transaction) => startTaskAttempt(transaction, {
      studyId: seeded.studyId, runId: seeded.runId, taskId: retryTask.id, taskKey: "retry", toolName: "deepResearch",
      skillVersion: 1, contextRetrievalId: null, arguments: {},
    }));
    assert.equal(second.attempt, 2);
    await database.transaction(async (transaction) => {
      await transaction.query("update study_task_attempts set status = 'completed', finished_at = now() where task_id = $1 and attempt = 2", [retryTask.id]);
      await transaction.query("update study_tool_invocations set status = 'completed', result = '{\"ok\":true}'::jsonb, finished_at = now() where id = $1", [second.invocationId]);
      await transaction.query("update study_tasks set status = 'completed', output = '{\"ok\":true}'::jsonb, finished_at = now() where id = $1", [retryTask.id]);
      for (const publicId of [`art_a_${suffix}`, `art_b_${suffix}`]) {
        await transaction.query(
          `insert into study_artifacts (public_id, study_id, run_id, task_id, artifact_type, title, content)
           values ($1, $2, $3, $4, 'smoke_output', 'Smoke output', '{"ok":true}'::jsonb)
           on conflict (run_id, task_id, artifact_type) do update set content = excluded.content`,
          [publicId, seeded.studyId, seeded.runId, retryTask.id],
        );
      }
    });
    const retryCounts = await database.query<{ attempts: number; artifacts: number; invocations: number }>(
      `select (select count(*)::int from study_task_attempts where task_id = $1) attempts,
              (select count(*)::int from study_artifacts where task_id = $1 and artifact_type = 'smoke_output') artifacts,
              (select count(*)::int from study_tool_invocations where task_id = $1) invocations`,
      [retryTask.id],
    );
    assert.deepEqual(retryCounts.rows[0], { attempts: 2, artifacts: 1, invocations: 1 });

    const waitingTask = await createTask("waiting", "waiting_input");
    await database.transaction(async (transaction) => {
      await transaction.query("update study_runs set status = 'waiting_input' where id = $1", [seeded.runId]);
      await transaction.query("update studies set status = 'waiting_input' where id = $1", [seeded.studyId]);
      await transaction.query(
        `insert into study_task_inputs (public_id, workspace_id, study_id, run_id, task_id, request_payload)
         values ($1, $2, $3, $4, $5, '{"title":"补充范围"}'::jsonb)`,
        [`tin_${suffix}`, workspaceId, seeded.studyId, seeded.runId, waitingTask.id],
      );
      await transaction.query("insert into study_job_queue (run_id, status) values ($1, 'waiting_input')", [seeded.runId]);
      const resumed = await submitTaskInput(transaction, {
        workspaceId: workspaceId!, viewerId: seeded.userId, studyPublicId: `std_${suffix}`,
        taskPublicId: waitingTask.public_id, response: { focus: "补充通勤场景", sourceUrls: ["https://example.com/source"] },
      });
      assert.notEqual(resumed, "not_found");
    });
    const waitingState = await database.query<{ task_status: string; run_status: string; job_status: string; input_status: string; resume_count: number }>(
      `select task.status as task_status, run.status as run_status, job.status as job_status,
              request.status as input_status, task.resume_count
       from study_tasks task join study_runs run on run.id = task.run_id
       join study_job_queue job on job.run_id = run.id join study_task_inputs request on request.task_id = task.id
       where task.id = $1`,
      [waitingTask.id],
    );
    assert.deepEqual(waitingState.rows[0], { task_status: "pending", run_status: "queued", job_status: "queued", input_status: "consumed", resume_count: 1 });

    const leaseTask = await createTask("lease");
    await database.transaction((transaction) => startTaskAttempt(transaction, {
      studyId: seeded.studyId, runId: seeded.runId, taskId: leaseTask.id, taskKey: "lease", toolName: "deepResearch",
      skillVersion: 1, contextRetrievalId: null, arguments: {},
    }));
    await database.query("update study_job_queue set status = 'leased', lease_owner = 'dead-worker', lease_expires_at = now() - interval '1 second' where run_id = $1", [seeded.runId]);
    const recovered = await database.transaction((transaction) => recoverInterruptedTasks(transaction, seeded.runId));
    assert(recovered.some((task) => task.task_key === "lease"));
    const recoveryState = await database.query<{ status: string; checkpoint_stable: boolean; interrupted: number }>(
      `select task.status, (checkpoint.state->'completed'->>'stable')::boolean as checkpoint_stable,
              (select count(*)::int from study_task_attempts where task_id = task.id and status = 'interrupted') interrupted
       from study_tasks task join study_run_checkpoints checkpoint on checkpoint.run_id = task.run_id where task.id = $1`,
      [leaseTask.id],
    );
    assert.deepEqual(recoveryState.rows[0], { status: "pending", checkpoint_stable: true, interrupted: 1 });
    assert.equal(classifyTaskError(new Error("OPENAI_API_KEY_MISSING")).disposition, "terminal");

    console.log(JSON.stringify({ retryAttempts: 2, artifactCount: 1, waitingInputResumed: true, leaseRecovered: true, terminalClassified: true }, null, 2));
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
