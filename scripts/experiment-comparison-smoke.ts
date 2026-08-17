import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { getInterviewSessionReplay } from "../src/lib/realtime-interviews";
import { getStrategyExperimentComparison } from "../src/lib/runtime-control";

if (process.env.EXPERIMENT_COMPARISON_SMOKE_CONFIRM !== "1") {
  throw new Error("Set EXPERIMENT_COMPARISON_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Experiment comparison smoke test only runs against a local database.");
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
         values ($1, $2, '{"display_name":"Experiment Smoke"}'::jsonb)`,
        [authUserId, `experiment-${suffix}@example.com`],
      );
      const actor = await transaction.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id
         from users app_user join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      const row = actor.rows[0];
      workspaceId = row.workspace_id;
      const project = await transaction.query<{ id: string }>(
        `insert into interview_projects (public_id, workspace_id, created_by, title, objective)
         values ($1, $2, $3, '实验对比烟测', '验证 variant 指标和版本回放映射') returning id::text as id`,
        [`inp_${suffix}`, row.workspace_id, row.user_id],
      );
      const experiment = await transaction.query<{ id: string }>(
        `insert into strategy_experiments (
           public_id, workspace_id, created_by, experiment_key, name, description,
           workflow_type, status, allocation_salt, started_at
         ) values ($1, $2, $3, $4, '追问深度实验', 'smoke', 'realtime_agent', 'active', $5, now())
         returning id::text as id`,
        [`exp_${suffix}`, row.workspace_id, row.user_id, `followup-${suffix}`, randomUUID()],
      );
      const variants = await transaction.query<{ id: string; variant_key: string }>(
        `insert into strategy_variants (
           public_id, experiment_id, variant_key, name, strategy_version, weight, config
         ) values
           ($1, $3, 'control', '基线', 'control-v1', 1, '{"maxFollowupsPerQuestion":1}'::jsonb),
           ($2, $3, 'deep', '深度追问', 'deep-v2', 1, '{"maxFollowupsPerQuestion":2}'::jsonb)
         returning id::text as id, variant_key`,
        [`var_control_${suffix}`, `var_deep_${suffix}`, experiment.rows[0].id],
      );
      const variantIds = new Map(variants.rows.map((variant) => [variant.variant_key, variant.id]));

      const contextContentHash = "a".repeat(64);
      const asset = await transaction.query<{ id: string }>(
        `insert into context_assets (
           public_id, workspace_id, created_by, asset_type, scope, title, source_hash
         ) values ($1, $2, $3, 'research_sample', 'workspace', '访谈策略规范', $4)
         returning id::text as id`,
        [`ctx_${suffix}`, row.workspace_id, row.user_id, contextContentHash],
      );
      const version = await transaction.query<{ id: string }>(
        `insert into context_asset_versions (
           public_id, asset_id, version, content, created_by, content_hash
         ) values ($1, $2, 1, '{"text":"先确认事实，再进行开放追问。"}'::jsonb, $3, $4)
         returning id::text as id`,
        [`ctv_${suffix}`, asset.rows[0].id, row.user_id, contextContentHash],
      );
      const chunk = await transaction.query<{ id: string }>(
        `insert into context_chunks (public_id, asset_version_id, ordinal, content)
         values ($1, $2, 0, '先确认事实，再进行开放追问。') returning id::text as id`,
        [`ctc_${suffix}`, version.rows[0].id],
      );

      const sessionIds: Record<string, { id: string; publicId: string }> = {};
      for (const [index, variantKey] of ["control", "deep"].entries()) {
        const publicId = `ins_${variantKey}_${suffix}`;
        const session = await transaction.query<{ id: string }>(
          `insert into interview_sessions (
             public_id, project_id, status, summary, insights, quotes, provider, provider_model,
             session_type, participant_name, workflow_type, workflow_version, skill_slug,
             skill_version, strategy_key, strategy_version, started_at, completed_at, last_activity_at
           ) values (
             $1, $2, 'completed', '完成', '[]'::jsonb, '[]'::jsonb, 'openai', 'gpt-smoke',
             'human', $3, 'realtime_agent', 'realtime-interview-agent-v1',
             'conduct-realtime-interview', 1, $4, $5, now() - interval '2 minutes', now(), now()
           ) returning id::text as id`,
          [publicId, project.rows[0].id, index === 0 ? "控制组参与者" : "实验组参与者", variantKey, index === 0 ? "control-v1" : "deep-v2"],
        );
        sessionIds[variantKey] = { id: session.rows[0].id, publicId };
        const retrieval = await transaction.query<{ id: string }>(
          `insert into context_retrievals (
             public_id, workspace_id, created_by, interview_session_id, query, strategy
           ) values ($1, $2, $3, $4, '访谈策略', 'lexical_metadata_v1') returning id::text as id`,
          [`ctr_${variantKey}_${suffix}`, row.workspace_id, row.user_id, session.rows[0].id],
        );
        await transaction.query(
          `insert into context_retrieval_items (retrieval_id, chunk_id, rank, score, reasons)
           values ($1, $2, 1, 0.9, '["title"]'::jsonb)`,
          [retrieval.rows[0].id, chunk.rows[0].id],
        );
        await transaction.query("update interview_sessions set context_retrieval_id = $2 where id = $1", [session.rows[0].id, retrieval.rows[0].id]);
        for (const message of [
          { role: "agent", type: "question", content: "请描述最近一次决策。" },
          { role: "participant", type: "answer", content: "我先比较了三个方案。" },
          { role: "agent", type: "closing", content: "感谢分享。" },
        ]) {
          const turnIndex = message.role === "agent" && message.type === "closing" ? 2 : message.role === "participant" ? 1 : 0;
          await transaction.query(
            `insert into interview_messages (
               public_id, session_id, turn_index, role, content, message_type,
               provider_response_id, provider_model, prompt_version, skill_slug, skill_version,
               strategy_version, context_retrieval_id
             ) values ($1, $2, $3, $4, $5, $6, $7, 'gpt-smoke', 'realtime-interview-v1',
                       'conduct-realtime-interview', 1, $8, $9)`,
            [
              `inm_${variantKey}_${turnIndex}_${suffix}`, session.rows[0].id, turnIndex, message.role,
              message.content, message.type, message.role === "agent" ? `resp_${variantKey}_${turnIndex}` : null,
              index === 0 ? "control-v1" : "deep-v2", retrieval.rows[0].id,
            ],
          );
        }
        const assignment = await transaction.query<{ id: string }>(
          `insert into strategy_assignments (
             public_id, experiment_id, variant_id, workspace_id, interview_session_id,
             subject_key, allocation_hash
           ) values ($1, $2, $3, $4, $5, $6, $7) returning id::text as id`,
          [`asg_${variantKey}_${suffix}`, experiment.rows[0].id, variantIds.get(variantKey), row.workspace_id, session.rows[0].id, `${variantKey}-${suffix}`, suffix],
        );
        await transaction.query(
          "update interview_sessions set experiment_assignment_id = $2 where id = $1",
          [session.rows[0].id, assignment.rows[0].id],
        );
        const duration = index === 0 ? 120_000 : 90_000;
        const tokens = index === 0 ? 900 : 1200;
        const quality = index === 0 ? 3.5 : 4.5;
        await transaction.query(
          `insert into strategy_metrics (assignment_id, metric_key, metric_value) values
             ($1, 'session_completed', 1), ($1, 'session_duration_ms', $2),
             ($1, 'session_tokens', $3), ($1, 'session_turns', 3),
             ($1, 'human_quality_score', $4)`,
          [assignment.rows[0].id, duration, tokens, quality],
        );
        await transaction.query(
          `insert into interview_quality_reviews (
             public_id, session_id, reviewer_user_id, relevance, depth, followup_quality,
             consistency, evidence_grounding, safety_compliance, overall_score, notes
           ) values ($1, $2, $3, $4, $4, $4, $4, $4, 5, $5, $6)`,
          [`iqr_${variantKey}_${suffix}`, session.rows[0].id, row.user_id, index === 0 ? 3 : 4, quality, `${variantKey} review`],
        );
      }
      return { ...row, projectPublicId: `inp_${suffix}`, experimentPublicId: `exp_${suffix}`, sessionIds };
    });

    const viewer = {
      userId: seeded.user_id,
      userPublicId: seeded.user_public_id,
      displayName: "Experiment Smoke",
      email: `experiment-${suffix}@example.com`,
      workspaceId: seeded.workspace_id,
      workspacePublicId: seeded.workspace_public_id,
      workspaceName: "Experiment Smoke",
      role: "owner" as const,
      tokenBalance: 0,
    };
    const comparison = await getStrategyExperimentComparison(viewer, seeded.experimentPublicId);
    assert(comparison);
    assert.equal(comparison.variants.length, 2);
    assert.equal(comparison.variants[0].metrics.assignments, 1);
    assert.equal(comparison.variants[0].metrics.averageDurationMs, 120_000);
    assert.equal(comparison.variants[1].metrics.averageTokens, 1200);
    assert.equal(comparison.variants[1].metrics.averageQualityScore, 4.5);
    assert.equal(comparison.variants[1].sessions[0].participantName, "实验组参与者");
    assert.equal(comparison.variants[1].sessions[0].contextRetrievalPublicId, `ctr_deep_${suffix}`);
    const replay = await getInterviewSessionReplay(viewer, seeded.projectPublicId, seeded.sessionIds.deep.publicId);
    assert(replay);
    assert.equal(replay.messages.length, 3);
    assert.equal(replay.context?.citations.length, 1);
    assert.equal(replay.reviews[0].overall_score, 4.5);
    assert.equal(replay.strategy.version, "deep-v2");
    console.log(JSON.stringify({
      experiment: comparison.experiment.publicId,
      variants: comparison.variants.map((variant) => ({
        key: variant.variantKey,
        assignments: variant.metrics.assignments,
        completionRate: variant.metrics.completionRate,
        averageDurationMs: variant.metrics.averageDurationMs,
        averageTokens: variant.metrics.averageTokens,
        averageQualityScore: variant.metrics.averageQualityScore,
        sessions: variant.sessions.length,
      })),
      replay: { messages: replay.messages.length, citations: replay.context?.citations.length, reviews: replay.reviews.length },
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
