import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { materializeRealtimeInterviewMetrics } from "../src/lib/realtime-interviews";

if (process.env.INTERVIEW_METRICS_SMOKE_CONFIRM !== "1") {
  throw new Error("Set INTERVIEW_METRICS_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Interview metrics smoke test only runs against a local database.");
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
         values ($1, $2, '{"display_name":"Interview metrics smoke"}'::jsonb)`,
        [authUserId, `interview-metrics-${suffix}@example.com`],
      );
      const owner = await transaction.query<{ user_id: string; workspace_id: string }>(
        `select member.user_id::text as user_id, member.workspace_id::text as workspace_id
         from workspace_members member join users app_user on app_user.id = member.user_id
         where app_user.auth_user_id = $1 and member.role in ('owner', 'admin') limit 1`,
        [authUserId],
      );
      if (!owner.rows[0]) throw new Error("SMOKE_OWNER_MISSING");
      workspaceId = owner.rows[0].workspace_id;
      const project = await transaction.query<{ id: string }>(
        `insert into interview_projects (public_id, workspace_id, created_by, title, objective, status)
         values ($1, $2, $3, '访谈指标烟测', '验证逐题覆盖率和追问命中率', 'active') returning id::text as id`,
        [`inp_metrics_${suffix}`, workspaceId, owner.rows[0].user_id],
      );
      const questions = await transaction.query<{ id: string }>(
        `insert into interview_questions (public_id, project_id, position, content)
         values ($1, $2, 1, '问题一'), ($3, $2, 2, '问题二'), ($4, $2, 3, '问题三'), ($5, $2, 4, '问题四')
         returning id::text as id`,
        [`inq_1_${suffix}`, project.rows[0].id, `inq_2_${suffix}`, `inq_3_${suffix}`, `inq_4_${suffix}`],
      );
      const experiment = await transaction.query<{ id: string }>(
        `insert into strategy_experiments (public_id, workspace_id, created_by, experiment_key, name, workflow_type, status, allocation_salt)
         values ($1, $2, $3, $4, '指标烟测实验', 'realtime_agent', 'active', $5) returning id::text as id`,
        [`exp_metrics_${suffix}`, workspaceId, owner.rows[0].user_id, `metrics-${suffix}`, randomUUID()],
      );
      const variant = await transaction.query<{ id: string }>(
        `insert into strategy_variants (public_id, experiment_id, variant_key, name, strategy_version)
         values ($1, $2, 'control', '控制组', 'metrics-v1') returning id::text as id`,
        [`var_metrics_${suffix}`, experiment.rows[0].id],
      );
      const session = await transaction.query<{ id: string }>(
        `insert into interview_sessions (public_id, project_id, status, summary, insights, quotes, provider, provider_model,
           session_type, participant_name, workflow_type, workflow_version, skill_slug, skill_version, strategy_key, strategy_version,
           started_at, last_activity_at)
         values ($1, $2, 'completed', '', '[]'::jsonb, '[]'::jsonb, 'smoke', 'smoke-model', 'human', '指标参与者',
           'realtime_agent', 'realtime-interview-agent-v1', 'conduct-realtime-interview', 1, 'control', 'metrics-v1', now(), now())
         returning id::text as id`,
        [`ins_metrics_${suffix}`, project.rows[0].id],
      );
      const assignment = await transaction.query<{ id: string }>(
        `insert into strategy_assignments (public_id, experiment_id, variant_id, workspace_id, interview_session_id, subject_key, allocation_hash)
         values ($1, $2, $3, $4, $5, $6, $7) returning id::text as id`,
        [`asg_metrics_${suffix}`, experiment.rows[0].id, variant.rows[0].id, workspaceId, session.rows[0].id, `metrics-${suffix}`, suffix],
      );
      await transaction.query("update interview_sessions set experiment_assignment_id = $2 where id = $1", [session.rows[0].id, assignment.rows[0].id]);
      const messages = [
        [0, "agent", "question", "问题一", questions.rows[0].id],
        [1, "participant", "answer", "这是一个足够具体且超过二十四字符的回答一。", questions.rows[0].id],
        [2, "agent", "followup", "请再补充一个细节。", questions.rows[0].id],
        [3, "participant", "answer", "这是追问后的具体回答，说明了实际决策过程。", questions.rows[0].id],
        [4, "agent", "question", "问题二", questions.rows[1].id],
        [5, "participant", "answer", "这是第二个问题的具体回答，也足够长。", questions.rows[1].id],
        [6, "agent", "question", "问题三", questions.rows[2].id],
        [7, "participant", "answer", "这是第三个问题的具体回答，也足够长。", questions.rows[2].id],
        [8, "agent", "followup", "还有别的原因吗？", questions.rows[2].id],
      ] as const;
      for (const [turn, role, type, content, questionId] of messages) {
        await transaction.query(
          `insert into interview_messages (public_id, session_id, turn_index, role, content, question_id, message_type)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [`inm_metrics_${suffix}_${turn}`, session.rows[0].id, turn, role, content, questionId, type],
        );
      }
      return { owner: owner.rows[0], projectId: project.rows[0].id, sessionId: session.rows[0].id, assignmentId: assignment.rows[0].id };
    });

    const metrics = await database.transaction((transaction) => materializeRealtimeInterviewMetrics(transaction, seeded.sessionId));
    assert(metrics);
    assert.equal(metrics.questionCount, 4);
    assert.equal(metrics.answeredQuestionCount, 3);
    assert.equal(metrics.coverageRate, 0.75);
    assert.equal(metrics.followupRequestedCount, 2);
    assert.equal(metrics.followupAnsweredCount, 1);
    assert.equal(metrics.followupHitRate, 0.5);
    await database.transaction((transaction) => materializeRealtimeInterviewMetrics(transaction, seeded.sessionId));
    const snapshot = await database.query<{ rows: number; strategy_rows: number }>(
      `select (select count(*)::int from interview_session_metrics where session_id = $1) as rows,
              (select count(*)::int from strategy_metrics where assignment_id = $2 and metric_key = 'question_coverage_rate') as strategy_rows`,
      [seeded.sessionId, seeded.assignmentId],
    );
    assert.deepEqual(snapshot.rows[0], { rows: 1, strategy_rows: 1 });
    console.log(JSON.stringify({ metrics, snapshot: snapshot.rows[0] }, null, 2));
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
