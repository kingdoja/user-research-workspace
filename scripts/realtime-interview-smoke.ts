import assert from "node:assert/strict";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { createPublicId } from "../src/lib/identifiers";
import {
  getInterviewSessionReplay,
  startRealtimeInterview,
  submitRealtimeInterviewTurn,
} from "../src/lib/realtime-interviews";

const scriptedAnswers = [
  "上周下雨，我临时比较了地铁和打车，主要考虑准时到达。",
  "我先查看预计时间，也比较了价格，最后因为会议不能迟到选择了打车。",
  "最关键的是到达时间的确定性，其次才是价格。",
  "如果天气正常，我通常会选择地铁，因为成本更低。",
];

async function main() {
  if (process.env.REALTIME_INTERVIEW_SMOKE_CONFIRM !== "1") {
    throw new Error("Set REALTIME_INTERVIEW_SMOKE_CONFIRM=1 to create and clean up remote smoke-test data.");
  }
  const database = await getDatabase();
  const owner = await database.query<{
    user_id: string;
    workspace_id: string;
    user_public_id: string;
  }>(
    `select member.user_id::text as user_id, member.workspace_id::text as workspace_id,
            app_user.public_id as user_public_id
     from workspace_members member
     join users app_user on app_user.id = member.user_id
     where member.role in ('owner', 'admin')
     order by member.created_at limit 1`,
  );
  const actor = owner.rows[0];
  if (!actor) throw new Error("SMOKE_OWNER_MISSING");

  const projectPublicId = createPublicId("int");
  const invitationToken = createPublicId("ivi");
  let projectId: string | null = null;
  try {
    projectId = await database.transaction(async (transaction) => {
      const project = await transaction.query<{ id: string }>(
        `insert into interview_projects (
           public_id, workspace_id, created_by, title, objective, status
         ) values ($1, $2, $3, $4, $5, 'active')
         returning id::text as id`,
        [
          projectPublicId,
          actor.workspace_id,
          actor.user_id,
          "P3 实时访谈 Provider 烟测",
          "仅用于验证实时访谈 Agent 的逐轮 Provider 调用、固定问题推进、版本回放和完成状态。",
        ],
      );
      const id = project.rows[0].id;
      await transaction.query(
        `insert into interview_questions (public_id, project_id, position, content)
         values ($1, $2, 1, $3), ($4, $2, 2, $5)`,
        [
          createPublicId("inq"), id, "请描述最近一次选择通勤方式时发生的具体情况。",
          createPublicId("inq"), "当时哪些因素最终影响了你的决定？",
        ],
      );
      await transaction.query(
        `insert into interview_invitations (
           public_id, project_id, created_by, token, expires_at
         ) values ($1, $2, $3, $4, now() + interval '1 hour')`,
        [createPublicId("inv"), id, actor.user_id, invitationToken],
      );
      return id;
    });

    const started = await startRealtimeInterview(invitationToken, {
      participantName: "自动化烟测参与者",
      participantEmail: "",
    });
    if (typeof started === "string") throw new Error(`SMOKE_START_${started}`);

    const recoveryKey = `smoke-recovery-${Date.now()}`;
    await database.transaction(async (transaction) => {
      const target = await transaction.query<{ session_id: string; question_id: string }>(
        `select session.id::text as session_id, question.id::text as question_id
         from interview_sessions session
         join interview_questions question on question.project_id = session.project_id
           and question.position = session.current_question_position
         where session.public_id = $1 limit 1`,
        [started.state.sessionPublicId],
      );
      await transaction.query(
        `insert into interview_messages (
           public_id, session_id, turn_index, role, content, question_id, message_type, idempotency_key
         ) values ($1, $2, 1, 'participant', $3, $4, 'answer', $5)`,
        [createPublicId("inm"), target.rows[0].session_id, scriptedAnswers[0], target.rows[0].question_id, recoveryKey],
      );
      await transaction.query(
        "update interview_sessions set status = 'responding', last_activity_at = now() where id = $1",
        [target.rows[0].session_id],
      );
    });
    const stillLeased = await submitRealtimeInterviewTurn(
      invitationToken, started.state.sessionPublicId, started.resumeToken,
      { content: scriptedAnswers[0], idempotencyKey: recoveryKey },
    );
    assert.equal(stillLeased, "pending_turn");
    await database.query(
      "update interview_sessions set last_activity_at = now() - interval '130 seconds' where public_id = $1",
      [started.state.sessionPublicId],
    );
    const recoveredTurn = await submitRealtimeInterviewTurn(
      invitationToken, started.state.sessionPublicId, started.resumeToken,
      { content: scriptedAnswers[0], idempotencyKey: recoveryKey },
    );
    if (typeof recoveredTurn === "string") throw new Error(`SMOKE_RECOVERY_${recoveredTurn}`);
    if ("provider_error" in recoveredTurn) throw new Error(`SMOKE_PROVIDER_${recoveredTurn.provider_error}`);

    let state;
    if ("status" in recoveredTurn) state = recoveredTurn;
    else if ("terminal" in recoveredTurn && recoveredTurn.terminal) state = recoveredTurn.terminal;
    else if ("recovered" in recoveredTurn && recoveredTurn.recovered) state = recoveredTurn.recovered;
    else throw new Error("SMOKE_RECOVERY_STATE_MISSING");
    let calls = 1;
    while (state.status !== "completed" && calls < scriptedAnswers.length) {
      const result = await submitRealtimeInterviewTurn(
        invitationToken,
        state.sessionPublicId,
        started.resumeToken,
        {
          content: scriptedAnswers[calls],
          idempotencyKey: `smoke-${Date.now()}-${calls}`,
        },
      );
      if (typeof result === "string") throw new Error(`SMOKE_TURN_${result}`);
      if ("provider_error" in result) throw new Error(`SMOKE_PROVIDER_${result.provider_error}`);
      if ("status" in result) state = result;
      else if ("terminal" in result && result.terminal) state = result.terminal;
      else if ("recovered" in result && result.recovered) state = result.recovered;
      else throw new Error("SMOKE_TURN_STATE_MISSING");
      calls += 1;
    }
    if (state.status !== "completed") throw new Error(`SMOKE_NOT_COMPLETED_${state.status}`);

    const replay = await getInterviewSessionReplay({
      userId: actor.user_id,
      userPublicId: actor.user_public_id,
      displayName: "Smoke",
      email: "smoke@example.com",
      workspaceId: actor.workspace_id,
      workspacePublicId: "smoke",
      workspaceName: "Smoke",
      role: "owner",
      tokenBalance: 0,
    }, projectPublicId, state.sessionPublicId);
    if (!replay) throw new Error("SMOKE_REPLAY_MISSING");
    const providerTurns = replay.messages.filter((message) => message.provider_response_id).length;
    if (
      providerTurns < 2
      || !replay.context?.retrievalPublicId
      || replay.skill?.slug !== "conduct-realtime-interview"
      || replay.workflow.status !== "completed"
    ) throw new Error("SMOKE_REPLAY_INVALID");

    console.log(JSON.stringify({
      completed: true,
      providerCalls: calls,
      crashedTurnRecovered: true,
      providerTurns,
      messageCount: replay.messages.length,
      roles: replay.messages.map((message) => message.role),
      workflow: replay.workflow,
      skill: replay.skill,
      strategy: replay.strategy,
      contextRetrieval: true,
      promptVersions: [...new Set(replay.messages.map((message) => message.prompt_version).filter(Boolean))],
    }));
  } finally {
    if (projectId) await database.query("delete from interview_projects where id = $1", [projectId]);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(closeDatabase);
