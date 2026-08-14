import { createHash, randomBytes } from "node:crypto";
import type { Viewer } from "@/lib/auth";
import { formatContextForPrompt, retrieveContext } from "@/lib/context-system";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import {
  describeOpenAIError,
  generateProviderRealtimeInterviewTurn,
  getOpenAIProviderStatus,
  REALTIME_INTERVIEW_PROMPT_VERSION,
} from "@/lib/openai-provider";
import { assignActiveStrategy, recordStrategyMetric } from "@/lib/runtime-control";

export const REALTIME_INTERVIEW_SKILL = {
  slug: "conduct-realtime-interview",
  version: 1,
  workflowVersion: "realtime-interview-agent-v1",
} as const;

type RealtimeStatus = "waiting_participant" | "responding" | "completed" | "cancelled" | "failed";

export type PublicRealtimeInterviewState = {
  sessionPublicId: string;
  status: RealtimeStatus;
  participantName: string;
  currentQuestionPosition: number;
  questionCount: number;
  error: string | null;
  messages: Array<{
    publicId: string;
    role: "agent" | "participant";
    messageType: "question" | "answer" | "followup" | "closing";
    content: string;
    createdAt: string;
  }>;
};

type RealtimeSessionRow = {
  id: string;
  public_id: string;
  project_id: string;
  project_title: string;
  objective: string;
  workspace_id: string;
  created_by: string;
  study_id: string | null;
  invitation_id: string;
  status: RealtimeStatus;
  participant_name: string;
  current_question_position: number;
  followup_count: number;
  context_retrieval_id: string | null;
  experiment_assignment_id: string | null;
  strategy_version: string;
  metadata: Record<string, unknown> | string;
  started_at: string;
  last_activity_at: string;
  timeout_seconds: number;
  error_message: string | null;
  token_count: number;
};

type RealtimeQuestion = { id: string; public_id: string; position: number; content: string };

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function hashResumeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function numericConfig(config: Record<string, unknown>, key: string, fallback: number, min: number, max: number) {
  const value = Number(config[key]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}

function usageTokens(usage: unknown) {
  if (!usage || typeof usage !== "object") return 0;
  const record = usage as Record<string, unknown>;
  for (const key of ["total_tokens", "totalTokens"]) {
    if (typeof record[key] === "number") return record[key];
  }
  const input = typeof record.input_tokens === "number" ? record.input_tokens : 0;
  const output = typeof record.output_tokens === "number" ? record.output_tokens : 0;
  return input + output;
}

async function getRealtimeSession(
  queryable: Queryable,
  invitationToken: string,
  sessionPublicId: string,
  resumeToken: string,
  lock = false,
) {
  const result = await queryable.query<RealtimeSessionRow>(
    `select session.id::text as id, session.public_id, session.project_id::text as project_id,
            project.title as project_title, project.objective, project.workspace_id::text as workspace_id,
            project.created_by::text as created_by, project.source_study_id::text as study_id,
            invitation.id::text as invitation_id, session.status, session.participant_name,
            session.current_question_position, session.followup_count,
            session.context_retrieval_id::text as context_retrieval_id,
            session.experiment_assignment_id::text as experiment_assignment_id,
            session.strategy_version, session.metadata, session.started_at::text as started_at,
            session.last_activity_at::text as last_activity_at, session.timeout_seconds,
            session.error_message,
            coalesce((session.metadata->>'tokenCount')::int, 0) as token_count
     from interview_sessions session
     join interview_projects project on project.id = session.project_id
     join interview_invitations invitation on invitation.id = session.invitation_id
     where invitation.token = $1 and session.public_id = $2
       and session.resume_token_hash = $3 and session.workflow_type = 'realtime_agent'
       and invitation.revoked_at is null
       and (invitation.expires_at is null or invitation.expires_at > now())
       and project.status <> 'archived'
     limit 1${lock ? " for update of session" : ""}`,
    [invitationToken, sessionPublicId, hashResumeToken(resumeToken)],
  );
  return result.rows[0] ?? null;
}

async function getQuestions(queryable: Queryable, projectId: string) {
  const result = await queryable.query<RealtimeQuestion>(
    `select id::text as id, public_id, position, content
     from interview_questions where project_id = $1 order by position`,
    [projectId],
  );
  return result.rows;
}

export async function materializeRealtimeInterviewMetrics(queryable: Queryable, sessionId: string) {
  const sessionResult = await queryable.query<{ project_id: string; assignment_id: string | null }>(
    `select project_id::text as project_id, experiment_assignment_id::text as assignment_id
     from interview_sessions where id = $1 limit 1`,
    [sessionId],
  );
  const session = sessionResult.rows[0];
  if (!session) return null;

  const [questions, answers, followups, substantive] = await Promise.all([
    queryable.query<{ count: number }>(
      "select count(*)::int as count from interview_questions where project_id = $1",
      [session.project_id],
    ),
    queryable.query<{ count: number }>(
      `select count(distinct question_id)::int as count
       from interview_messages
       where session_id = $1 and role = 'participant' and question_id is not null`,
      [sessionId],
    ),
    queryable.query<{ requested: number; answered: number }>(
      `select count(*) filter (where message.message_type = 'followup')::int as requested,
              count(*) filter (where message.message_type = 'followup' and exists (
                select 1 from interview_messages answer
                where answer.session_id = message.session_id and answer.role = 'participant'
                  and answer.turn_index = message.turn_index + 1
              ))::int as answered
       from interview_messages message where message.session_id = $1 and message.role = 'agent'`,
      [sessionId],
    ),
    queryable.query<{ count: number }>(
      `select count(*)::int as count from interview_messages
       where session_id = $1 and role = 'participant' and length(trim(content)) >= 24`,
      [sessionId],
    ),
  ]);
  const questionCount = Number(questions.rows[0]?.count ?? 0);
  const answeredQuestionCount = Number(answers.rows[0]?.count ?? 0);
  const followupRequestedCount = Number(followups.rows[0]?.requested ?? 0);
  const followupAnsweredCount = Number(followups.rows[0]?.answered ?? 0);
  const coverageRate = questionCount ? answeredQuestionCount / questionCount : 0;
  const followupHitRate = followupRequestedCount ? followupAnsweredCount / followupRequestedCount : 0;
  const substantiveAnswerCount = Number(substantive.rows[0]?.count ?? 0);
  const metadata = { metricVersion: "realtime-interview-metrics-v1", sessionId };
  await queryable.query(
    `insert into interview_session_metrics (
       public_id, session_id, project_id, assignment_id, question_count,
       answered_question_count, coverage_rate, followup_requested_count,
       followup_answered_count, followup_hit_rate, substantive_answer_count, metric_version
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (session_id) do update set
       project_id = excluded.project_id, assignment_id = excluded.assignment_id,
       question_count = excluded.question_count, answered_question_count = excluded.answered_question_count,
       coverage_rate = excluded.coverage_rate, followup_requested_count = excluded.followup_requested_count,
       followup_answered_count = excluded.followup_answered_count, followup_hit_rate = excluded.followup_hit_rate,
       substantive_answer_count = excluded.substantive_answer_count, metric_version = excluded.metric_version,
       updated_at = now()`,
    [createPublicId("ism"), sessionId, session.project_id, session.assignment_id,
      questionCount, answeredQuestionCount, coverageRate, followupRequestedCount,
      followupAnsweredCount, followupHitRate, substantiveAnswerCount, "realtime-interview-metrics-v1"],
  );
  await Promise.all([
    recordStrategyMetric(queryable, session.assignment_id, "question_count", questionCount, metadata),
    recordStrategyMetric(queryable, session.assignment_id, "answered_question_count", answeredQuestionCount, metadata),
    recordStrategyMetric(queryable, session.assignment_id, "question_coverage_rate", coverageRate, metadata),
    recordStrategyMetric(queryable, session.assignment_id, "followup_requested_count", followupRequestedCount, metadata),
    recordStrategyMetric(queryable, session.assignment_id, "followup_answered_count", followupAnsweredCount, metadata),
    recordStrategyMetric(queryable, session.assignment_id, "followup_hit_rate", followupHitRate, metadata),
    recordStrategyMetric(queryable, session.assignment_id, "substantive_answer_count", substantiveAnswerCount, metadata),
  ]);
  return {
    questionCount,
    answeredQuestionCount,
    coverageRate,
    followupRequestedCount,
    followupAnsweredCount,
    followupHitRate,
    substantiveAnswerCount,
  };
}

async function buildPublicState(queryable: Queryable, session: RealtimeSessionRow): Promise<PublicRealtimeInterviewState> {
  const [messages, questions] = await Promise.all([
    queryable.query<{
      public_id: string; role: "agent" | "participant"; message_type: PublicRealtimeInterviewState["messages"][number]["messageType"];
      content: string; created_at: string;
    }>(
      `select public_id, role, message_type, content, created_at::text as created_at
       from interview_messages where session_id = $1 and role in ('agent', 'participant')
       order by turn_index`,
      [session.id],
    ),
    getQuestions(queryable, session.project_id),
  ]);
  return {
    sessionPublicId: session.public_id,
    status: session.status,
    participantName: session.participant_name,
    currentQuestionPosition: session.current_question_position,
    questionCount: questions.length,
    error: session.error_message,
    messages: messages.rows.map((message) => ({
      publicId: message.public_id,
      role: message.role,
      messageType: message.message_type,
      content: message.content,
      createdAt: message.created_at,
    })),
  };
}

export async function startRealtimeInterview(invitationToken: string, input: {
  participantName: string;
  participantEmail?: string;
}) {
  const provider = getOpenAIProviderStatus();
  if (!provider.configured) return "provider_missing" as const;
  const database = await getDatabase();
  const invitation = await database.query<{
    id: string; project_id: string; project_title: string; objective: string; workspace_id: string;
    created_by: string; study_id: string | null;
  }>(
    `select invitation.id::text as id, project.id::text as project_id, project.title as project_title,
            project.objective, project.workspace_id::text as workspace_id,
            project.created_by::text as created_by, project.source_study_id::text as study_id
     from interview_invitations invitation
     join interview_projects project on project.id = invitation.project_id
     where invitation.token = $1 and invitation.revoked_at is null
       and (invitation.expires_at is null or invitation.expires_at > now())
       and project.status <> 'archived' limit 1`,
    [invitationToken],
  );
  const invitationRow = invitation.rows[0];
  if (!invitationRow) return "not_found" as const;
  const questions = await getQuestions(database, invitationRow.project_id);
  if (!questions.length) return "no_questions" as const;

  const resumeToken = randomBytes(32).toString("base64url");
  const sessionPublicId = createPublicId("ins");
  const session = await database.transaction(async (transaction) => {
    const inserted = await transaction.query<{ id: string }>(
      `insert into interview_sessions (
         public_id, project_id, persona_id, status, summary, insights, quotes, provider,
         provider_model, session_type, participant_name, participant_email, workflow_type,
         workflow_version, skill_slug, skill_version, invitation_id, resume_token_hash,
         current_question_position, started_at, last_activity_at
       ) values (
         $1, $2, null, 'waiting_participant', '', '[]'::jsonb, '[]'::jsonb, $3,
         $4, 'human', $5, $6, 'realtime_agent', $7, $8, $9, $10, $11, 1, now(), now()
       ) returning id::text as id`,
      [
        sessionPublicId, invitationRow.project_id, provider.providerName, provider.researchModel,
        input.participantName, input.participantEmail || null, REALTIME_INTERVIEW_SKILL.workflowVersion,
        REALTIME_INTERVIEW_SKILL.slug, REALTIME_INTERVIEW_SKILL.version, invitationRow.id,
        hashResumeToken(resumeToken),
      ],
    );
    const assignment = await assignActiveStrategy({
      queryable: transaction,
      workspaceId: invitationRow.workspace_id,
      studyId: invitationRow.study_id,
      interviewSessionId: inserted.rows[0].id,
      subjectKey: `${invitationRow.id}:${sessionPublicId}`,
      workflowType: "realtime_agent",
    });
    const maxFollowups = numericConfig(assignment.config, "maxFollowupsPerQuestion", 1, 0, 3);
    const timeoutSeconds = numericConfig(assignment.config, "sessionTimeoutSeconds", 1800, 60, 7200);
    const instructionSuffix = typeof assignment.config.instructionSuffix === "string"
      ? assignment.config.instructionSuffix.trim().slice(0, 2000)
      : "";
    await transaction.query(
      `update interview_sessions set experiment_assignment_id = $2, strategy_key = $3,
              strategy_version = $4, timeout_seconds = $5, metadata = $6::jsonb
       where id = $1`,
      [
        inserted.rows[0].id, assignment.assignmentId, assignment.variantKey, assignment.strategyVersion,
        timeoutSeconds, JSON.stringify({ experimentKey: assignment.experimentKey, maxFollowups, instructionSuffix }),
      ],
    );
    await transaction.query(
      `insert into interview_messages (
         public_id, session_id, turn_index, role, content, question_id, message_type,
         prompt_version, skill_slug, skill_version, strategy_version
       ) values ($1, $2, 0, 'agent', $3, $4, 'question', $5, $6, $7, $8)`,
      [
        createPublicId("inm"), inserted.rows[0].id, questions[0].content, questions[0].id,
        REALTIME_INTERVIEW_PROMPT_VERSION, REALTIME_INTERVIEW_SKILL.slug,
        REALTIME_INTERVIEW_SKILL.version, assignment.strategyVersion,
      ],
    );
    return {
      id: inserted.rows[0].id,
      assignmentId: assignment.assignmentId,
      strategyVersion: assignment.strategyVersion,
    };
  });

  const context = await retrieveContext({
    workspaceId: invitationRow.workspace_id,
    userId: invitationRow.created_by,
    studyId: invitationRow.study_id ?? undefined,
    interviewSessionId: session.id,
    query: `${invitationRow.project_title}\n${invitationRow.objective}\n${questions.map((question) => question.content).join("\n")}`,
    scopes: invitationRow.study_id ? ["workspace", "study", "system"] : ["workspace", "system"],
    limit: 6,
  });
  if (context.retrievalId) {
    await database.transaction(async (transaction) => {
      await transaction.query("update interview_sessions set context_retrieval_id = $2 where id = $1", [session.id, context.retrievalId]);
      await transaction.query("update interview_messages set context_retrieval_id = $2 where session_id = $1", [session.id, context.retrievalId]);
    });
  }
  await recordStrategyMetric(database, session.assignmentId, "session_started", 1, {
    workflowVersion: REALTIME_INTERVIEW_SKILL.workflowVersion,
    skill: `${REALTIME_INTERVIEW_SKILL.slug}@${REALTIME_INTERVIEW_SKILL.version}`,
    contextRetrievalPublicId: context.retrievalPublicId,
  });
  const stored = await getRealtimeSession(database, invitationToken, sessionPublicId, resumeToken);
  if (!stored) throw new Error("REALTIME_SESSION_CREATE_FAILED");
  return { status: "started" as const, resumeToken, state: await buildPublicState(database, stored) };
}

export async function getRealtimeInterviewState(invitationToken: string, sessionPublicId: string, resumeToken: string) {
  const database = await getDatabase();
  const session = await getRealtimeSession(database, invitationToken, sessionPublicId, resumeToken);
  if (!session) return "not_found" as const;
  return buildPublicState(database, session);
}

export async function submitRealtimeInterviewTurn(invitationToken: string, sessionPublicId: string, resumeToken: string, input: {
  content: string;
  idempotencyKey: string;
}) {
  const database = await getDatabase();
  const claimed = await database.transaction(async (transaction) => {
    const session = await getRealtimeSession(transaction, invitationToken, sessionPublicId, resumeToken, true);
    if (!session) return "not_found" as const;
    if (session.status === "completed" || session.status === "cancelled" || session.status === "failed") {
      return { terminal: await buildPublicState(transaction, session) };
    }
    const idleMilliseconds = Date.now() - new Date(session.last_activity_at).getTime();
    if (idleMilliseconds > session.timeout_seconds * 1000) {
      await transaction.query(
        `update interview_sessions set status = 'failed', failed_at = now(),
                error_message = '访谈已超过会话时限' where id = $1`,
        [session.id],
      );
      await materializeRealtimeInterviewMetrics(transaction, session.id);
      await recordStrategyMetric(transaction, session.experiment_assignment_id, "session_failed", 1, { reason: "timeout" });
      return "expired" as const;
    }
    const existing = await transaction.query<{ turn_index: number }>(
      `select turn_index from interview_messages
       where session_id = $1 and idempotency_key = $2 and role = 'participant' limit 1`,
      [session.id, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const existingReply = await transaction.query<{ id: string }>(
        `select id::text as id from interview_messages
         where session_id = $1 and turn_index > $2 and role = 'agent' limit 1`,
        [session.id, existing.rows[0].turn_index],
      );
      if (existingReply.rows[0]) return { recovered: await buildPublicState(transaction, session) };
    }
    if (!existing.rows[0]) {
      const lastMessage = await transaction.query<{ role: string; idempotency_key: string | null }>(
        `select role, idempotency_key from interview_messages where session_id = $1 order by turn_index desc limit 1`,
        [session.id],
      );
      if (lastMessage.rows[0]?.role === "participant") return "pending_turn" as const;
      const nextIndex = await transaction.query<{ value: number }>(
        "select coalesce(max(turn_index), -1) + 1 as value from interview_messages where session_id = $1",
        [session.id],
      );
      const question = await transaction.query<{ id: string }>(
        "select id::text as id from interview_questions where project_id = $1 and position = $2 limit 1",
        [session.project_id, session.current_question_position],
      );
      await transaction.query(
        `insert into interview_messages (
           public_id, session_id, turn_index, role, content, question_id, message_type,
           idempotency_key, skill_slug, skill_version, strategy_version, context_retrieval_id
         ) values ($1, $2, $3, 'participant', $4, $5, 'answer', $6, $7, $8, $9, $10)`,
        [
          createPublicId("inm"), session.id, nextIndex.rows[0].value, input.content,
          question.rows[0]?.id ?? null, input.idempotencyKey, REALTIME_INTERVIEW_SKILL.slug,
          REALTIME_INTERVIEW_SKILL.version, session.strategy_version, session.context_retrieval_id,
        ],
      );
    }
    await transaction.query(
      `update interview_sessions set status = 'responding', error_message = null,
              last_activity_at = now(), updated_at = now() where id = $1`,
      [session.id],
    );
    return session;
  });
  if (claimed === "not_found" || claimed === "expired" || claimed === "pending_turn") return claimed;
  if ("terminal" in claimed) return claimed;
  if ("recovered" in claimed) return claimed.recovered;

  const [questions, messages, contextResult] = await Promise.all([
    getQuestions(database, claimed.project_id),
    database.query<{ role: "agent" | "participant"; content: string }>(
      `select role, content from interview_messages
       where session_id = $1 and role in ('agent', 'participant') order by turn_index`,
      [claimed.id],
    ),
    claimed.context_retrieval_id
      ? database.query<{ content: string; title: string; version: number; chunk_public_id: string }>(
        `select chunk.content, asset.title, version.version, chunk.public_id as chunk_public_id
         from context_retrieval_items item
         join context_chunks chunk on chunk.id = item.chunk_id
         join context_asset_versions version on version.id = chunk.asset_version_id
         join context_assets asset on asset.id = version.asset_id
         where item.retrieval_id = $1 order by item.rank`,
        [claimed.context_retrieval_id],
      )
      : Promise.resolve({ rows: [] as Array<{ content: string; title: string; version: number; chunk_public_id: string }> }),
  ]);
  const metadata = parseJson<Record<string, unknown>>(claimed.metadata);
  const maxFollowups = numericConfig(metadata, "maxFollowups", 1, 0, 3);
  const instructionSuffix = typeof metadata.instructionSuffix === "string" ? metadata.instructionSuffix : "";
  const contextText = formatContextForPrompt({
    retrievalId: claimed.context_retrieval_id,
    retrievalPublicId: null,
    strategy: "lexical_metadata_v1",
    query: claimed.objective,
    citations: contextResult.rows.map((item) => ({
      chunkPublicId: item.chunk_public_id, assetPublicId: "", assetVersionPublicId: "",
      assetType: "", scope: "workspace" as const, title: item.title, sourceUri: null,
      version: item.version, content: item.content, score: 0, reasons: [],
    })),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("REALTIME_INTERVIEW_TIMEOUT")), 90_000);
  let providerTurn;
  try {
    providerTurn = await generateProviderRealtimeInterviewTurn({
      projectTitle: claimed.project_title,
      objective: claimed.objective,
      fixedQuestions: questions.map((question) => question.content),
      currentQuestionPosition: claimed.current_question_position,
      followupCount: claimed.followup_count,
      maxFollowupsPerQuestion: maxFollowups,
      conversation: messages.rows,
      context: contextText,
      strategyInstruction: instructionSuffix,
      participantSafetyId: claimed.public_id,
      signal: controller.signal,
    });
  } catch (error) {
    const described = describeOpenAIError(error);
    await database.query(
      `update interview_sessions set status = 'waiting_participant', error_message = $2,
              updated_at = now() where id = $1 and status = 'responding'`,
      [claimed.id, described.message],
    );
    return { provider_error: described.message } as const;
  } finally {
    clearTimeout(timeout);
  }

  const completed = claimed.current_question_position >= questions.length
    && (providerTurn.action !== "followup" || claimed.followup_count >= maxFollowups);
  const followup = !completed
    && providerTurn.action === "followup"
    && claimed.followup_count < maxFollowups;
  const nextPosition = followup ? claimed.current_question_position : claimed.current_question_position + 1;
  const nextQuestion = questions[nextPosition - 1];
  const messageContent = completed
    ? providerTurn.action === "complete" ? providerTurn.message : "感谢你的分享，本次访谈已经完成。"
    : followup
      ? providerTurn.message
      : nextQuestion?.content ?? providerTurn.message;
  const messageType = completed ? "closing" : followup ? "followup" : "question";

  const saved = await database.transaction(async (transaction) => {
    const session = await getRealtimeSession(transaction, invitationToken, sessionPublicId, resumeToken, true);
    if (!session) return "not_found" as const;
    const participant = await transaction.query<{ turn_index: number }>(
      `select turn_index from interview_messages
       where session_id = $1 and idempotency_key = $2 and role = 'participant' limit 1`,
      [session.id, input.idempotencyKey],
    );
    if (!participant.rows[0]) return "not_found" as const;
    const existingReply = await transaction.query<{ id: string }>(
      `select id::text as id from interview_messages
       where session_id = $1 and turn_index > $2 and role = 'agent' limit 1`,
      [session.id, participant.rows[0].turn_index],
    );
    if (!existingReply.rows[0]) {
      const questionId = completed ? questions.at(-1)?.id : followup
        ? questions[claimed.current_question_position - 1]?.id
        : nextQuestion?.id;
      await transaction.query(
        `insert into interview_messages (
           public_id, session_id, turn_index, role, content, question_id, message_type,
           provider_response_id, provider_model, prompt_version, skill_slug, skill_version,
           strategy_version, context_retrieval_id, metadata
         ) values ($1, $2, $3, 'agent', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
        [
          createPublicId("inm"), session.id, participant.rows[0].turn_index + 1, messageContent,
          questionId ?? null, messageType, providerTurn.responseId, providerTurn.model,
          providerTurn.promptVersion, REALTIME_INTERVIEW_SKILL.slug, REALTIME_INTERVIEW_SKILL.version,
          session.strategy_version, session.context_retrieval_id,
          JSON.stringify({ rationale: providerTurn.rationale, requestedAction: providerTurn.action, usage: providerTurn.usage }),
        ],
      );
      await transaction.query(
        `update interview_sessions set status = $2, current_question_position = $3,
                followup_count = $4, summary = $5, insights = $6::jsonb, quotes = $7::jsonb,
                provider_model = $8, metadata = jsonb_set(metadata, '{tokenCount}', to_jsonb($9::int), true),
                error_message = null, last_activity_at = now(),
                completed_at = case when $2 = 'completed' then now() else completed_at end,
                updated_at = now()
         where id = $1`,
        [
          session.id, completed ? "completed" : "waiting_participant",
          completed ? claimed.current_question_position : nextPosition,
          followup ? claimed.followup_count + 1 : 0,
          completed ? providerTurn.summary || `${session.participant_name} 完成了 ${questions.length} 个核心问题的实时访谈。` : "",
          JSON.stringify(completed ? providerTurn.insights : []),
          JSON.stringify(completed ? (providerTurn.quotes.length ? providerTurn.quotes : messages.rows.filter((message) => message.role === "participant").slice(-3).map((message) => message.content)) : []), providerTurn.model,
          session.token_count + usageTokens(providerTurn.usage),
        ],
      );
      await materializeRealtimeInterviewMetrics(transaction, session.id);
      if (completed) {
        const duration = Date.now() - new Date(session.started_at).getTime();
        await recordStrategyMetric(transaction, session.experiment_assignment_id, "session_completed", 1);
        await recordStrategyMetric(transaction, session.experiment_assignment_id, "session_duration_ms", duration);
        await recordStrategyMetric(transaction, session.experiment_assignment_id, "session_tokens", session.token_count + usageTokens(providerTurn.usage));
        await recordStrategyMetric(transaction, session.experiment_assignment_id, "session_turns", participant.rows[0].turn_index + 2);
      }
    }
    const updated = await getRealtimeSession(transaction, invitationToken, sessionPublicId, resumeToken);
    return updated ? buildPublicState(transaction, updated) : "not_found" as const;
  });
  return saved;
}

export async function cancelRealtimeInterview(invitationToken: string, sessionPublicId: string, resumeToken: string) {
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const session = await getRealtimeSession(transaction, invitationToken, sessionPublicId, resumeToken, true);
    if (!session) return "not_found" as const;
    if (session.status === "completed" || session.status === "cancelled") return buildPublicState(transaction, session);
    await transaction.query(
      `update interview_sessions set status = 'cancelled', cancel_requested_at = now(),
              cancelled_at = now(), last_activity_at = now(), updated_at = now()
       where id = $1`,
      [session.id],
    );
    await materializeRealtimeInterviewMetrics(transaction, session.id);
    await recordStrategyMetric(transaction, session.experiment_assignment_id, "session_cancelled", 1);
    await recordStrategyMetric(transaction, session.experiment_assignment_id, "run_cancelled", 1, { workflowType: "realtime_agent" });
    const updated = await getRealtimeSession(transaction, invitationToken, sessionPublicId, resumeToken);
    return updated ? buildPublicState(transaction, updated) : "not_found" as const;
  });
}

export async function getInterviewSessionReplay(viewer: Viewer, projectPublicId: string, sessionPublicId: string) {
  const database = await getDatabase();
  const session = await database.query<{
    id: string; public_id: string; workflow_type: string; workflow_version: string; status: string;
    skill_slug: string | null; skill_version: number | null; strategy_key: string; strategy_version: string;
    context_public_id: string | null; context_strategy: string | null; started_at: string | null;
    completed_at: string | null; metadata: Record<string, unknown> | string;
  }>(
    `select session.id::text as id, session.public_id, session.workflow_type, session.workflow_version,
            session.status, session.skill_slug, session.skill_version, session.strategy_key,
            session.strategy_version, retrieval.public_id as context_public_id,
            retrieval.strategy as context_strategy, session.started_at::text as started_at,
            session.completed_at::text as completed_at, session.metadata
     from interview_sessions session
     join interview_projects project on project.id = session.project_id
     left join context_retrievals retrieval on retrieval.id = session.context_retrieval_id
     where project.public_id = $1 and project.workspace_id = $2 and session.public_id = $3 limit 1`,
    [projectPublicId, viewer.workspaceId, sessionPublicId],
  );
  const row = session.rows[0];
  if (!row) return null;
  const [messages, citations, reviews, metrics] = await Promise.all([
    database.query<{
      public_id: string; turn_index: number; role: string; message_type: string; content: string;
      provider_response_id: string | null; provider_model: string | null; prompt_version: string | null;
      skill_slug: string | null; skill_version: number | null; strategy_version: string | null;
      created_at: string; metadata: Record<string, unknown> | string;
    }>(
      `select public_id, turn_index, role, message_type, content, provider_response_id,
              provider_model, prompt_version, skill_slug, skill_version, strategy_version,
              created_at::text as created_at, metadata
       from interview_messages where session_id = $1 order by turn_index`,
      [row.id],
    ),
    database.query<{
      rank: number; title: string; version: number; asset_public_id: string;
      version_public_id: string; chunk_public_id: string; source_uri: string | null;
    }>(
      `select item.rank, asset.title, version.version, asset.public_id as asset_public_id,
              version.public_id as version_public_id, chunk.public_id as chunk_public_id, asset.source_uri
       from interview_sessions session
       join context_retrieval_items item on item.retrieval_id = session.context_retrieval_id
       join context_chunks chunk on chunk.id = item.chunk_id
       join context_asset_versions version on version.id = chunk.asset_version_id
       join context_assets asset on asset.id = version.asset_id
       where session.id = $1 order by item.rank`,
      [row.id],
    ),
    database.query<{
      public_id: string; reviewer_name: string; relevance: number; depth: number; followup_quality: number;
      consistency: number; evidence_grounding: number; safety_compliance: number; overall_score: number;
      notes: string; updated_at: string;
    }>(
      `select review.public_id, reviewer.display_name as reviewer_name, review.relevance, review.depth,
              review.followup_quality, review.consistency, review.evidence_grounding,
              review.safety_compliance, review.overall_score, review.notes,
              review.updated_at::text as updated_at
       from interview_quality_reviews review join users reviewer on reviewer.id = review.reviewer_user_id
       where review.session_id = $1 order by review.updated_at desc`,
      [row.id],
    ),
    database.query<{
      question_count: number; answered_question_count: number; coverage_rate: number;
      followup_requested_count: number; followup_answered_count: number; followup_hit_rate: number;
      substantive_answer_count: number; metric_version: string;
    }>(
      `select question_count, answered_question_count, coverage_rate,
              followup_requested_count, followup_answered_count, followup_hit_rate,
              substantive_answer_count, metric_version
       from interview_session_metrics where session_id = $1 limit 1`,
      [row.id],
    ),
  ]);
  return {
    sessionPublicId: row.public_id,
    workflow: { type: row.workflow_type, version: row.workflow_version, status: row.status },
    skill: row.skill_slug ? { slug: row.skill_slug, version: row.skill_version } : null,
    strategy: { key: row.strategy_key, version: row.strategy_version },
    context: row.context_public_id ? { retrievalPublicId: row.context_public_id, strategy: row.context_strategy, citations: citations.rows } : null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    metadata: parseJson(row.metadata),
    metrics: metrics.rows[0] ? {
      questionCount: metrics.rows[0].question_count,
      answeredQuestionCount: metrics.rows[0].answered_question_count,
      coverageRate: Number(metrics.rows[0].coverage_rate),
      followupRequestedCount: metrics.rows[0].followup_requested_count,
      followupAnsweredCount: metrics.rows[0].followup_answered_count,
      followupHitRate: Number(metrics.rows[0].followup_hit_rate),
      substantiveAnswerCount: metrics.rows[0].substantive_answer_count,
      metricVersion: metrics.rows[0].metric_version,
    } : null,
    messages: messages.rows.map((message) => ({ ...message, metadata: parseJson(message.metadata) })),
    reviews: reviews.rows,
  };
}

export async function saveInterviewQualityReview(viewer: Viewer, projectPublicId: string, sessionPublicId: string, input: {
  relevance: number;
  depth: number;
  followupQuality: number;
  consistency: number;
  evidenceGrounding: number;
  safetyCompliance: number;
  notes: string;
}) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const session = await transaction.query<{ id: string; assignment_id: string | null }>(
      `select session.id::text as id, session.experiment_assignment_id::text as assignment_id
       from interview_sessions session join interview_projects project on project.id = session.project_id
       where project.public_id = $1 and project.workspace_id = $2 and session.public_id = $3 limit 1`,
      [projectPublicId, viewer.workspaceId, sessionPublicId],
    );
    const target = session.rows[0];
    if (!target) return "not_found" as const;
    const dimensions = [input.relevance, input.depth, input.followupQuality, input.consistency, input.evidenceGrounding, input.safetyCompliance];
    const overall = dimensions.reduce((total, score) => total + score, 0) / dimensions.length;
    const review = await transaction.query<{ public_id: string; updated_at: string }>(
      `insert into interview_quality_reviews (
         public_id, session_id, reviewer_user_id, relevance, depth, followup_quality,
         consistency, evidence_grounding, safety_compliance, overall_score, notes
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (session_id, reviewer_user_id) do update set
         relevance = excluded.relevance, depth = excluded.depth,
         followup_quality = excluded.followup_quality, consistency = excluded.consistency,
         evidence_grounding = excluded.evidence_grounding,
         safety_compliance = excluded.safety_compliance, overall_score = excluded.overall_score,
         notes = excluded.notes, updated_at = now()
       returning public_id, updated_at::text as updated_at`,
      [
        createPublicId("iqr"), target.id, viewer.userId, input.relevance, input.depth,
        input.followupQuality, input.consistency, input.evidenceGrounding,
        input.safetyCompliance, overall, input.notes,
      ],
    );
    await recordStrategyMetric(transaction, target.assignment_id, "human_quality_score", overall, {
      reviewerUserPublicId: viewer.userPublicId,
      dimensions: {
        relevance: input.relevance, depth: input.depth, followupQuality: input.followupQuality,
        consistency: input.consistency, evidenceGrounding: input.evidenceGrounding,
        safetyCompliance: input.safetyCompliance,
      },
    });
    return { publicId: review.rows[0].public_id, overallScore: overall, updatedAt: review.rows[0].updated_at };
  });
}
