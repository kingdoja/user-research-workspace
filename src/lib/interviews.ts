import type { Viewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { CreateInterviewProjectInput } from "@/lib/interview-schema";
import {
  describeOpenAIError,
  generateProviderSyntheticInterviews,
  getOpenAIProviderStatus,
  type SyntheticPanelResearch,
} from "@/lib/openai-provider";

export type InterviewProjectSummary = {
  publicId: string;
  title: string;
  objective: string;
  status: "active" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
  panel: { publicId: string; title: string } | null;
  study: { publicId: string; title: string } | null;
  personas: Array<{ publicId: string; name: string }>;
};

export type InterviewSessionDetail = {
  publicId: string;
  status: "running" | "completed" | "failed";
  summary: string;
  insights: string[];
  quotes: string[];
  sessionType: "ai" | "human";
  participantName: string;
  participantEmail: string | null;
  persona: {
    publicId: string;
    name: string;
    archetype: string;
    profile: SyntheticPanelResearch["personas"][number];
  } | null;
  messages: Array<{
    id: string;
    role: "interviewer" | "persona";
    content: string;
  }>;
};

export type InterviewProjectDetail = InterviewProjectSummary & {
  runStatus: "queued" | "running" | "completed" | "failed" | "cancelled" | null;
  runError: string | null;
  runAttempt: number;
  runRecoverable: boolean;
  runEvents: Array<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  runHistory: Array<{
    publicId: string;
    attempt: number;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    provider: string | null;
    model: string | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  sessions: InterviewSessionDetail[];
  questions: Array<{
    publicId: string;
    index: number;
    question: string;
    questionType: "open" | "single" | "multiple";
    options: string[];
    aiPrompt: string | null;
    imagePaths: string[];
    imageUrls: string[];
    answers: Array<{
      personaPublicId: string | null;
      personaName: string;
      answer: string;
    }>;
  }>;
  invitations: Array<{
    publicId: string;
    token: string;
    expiresAt: string | null;
    createdAt: string;
  }>;
};

export type PublicInterviewInvitation = {
  token: string;
  projectTitle: string;
  objective: string;
  expiresAt: string | null;
  questions: Array<{
    publicId: string;
    index: number;
    content: string;
    questionType: "open" | "single" | "multiple";
    options: string[];
    imageUrls: string[];
  }>;
};

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

const INTERVIEW_IMAGE_BUCKET = "interview-question-images";

function getInterviewImageUrl(path: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return "";
  return `${supabaseUrl}/storage/v1/object/public/${INTERVIEW_IMAGE_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export async function listInterviewProjects(viewer: Viewer): Promise<InterviewProjectSummary[]> {
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string;
    title: string;
    objective: string;
    status: InterviewProjectSummary["status"];
    created_at: string;
    updated_at: string;
    session_count: number;
    panel_public_id: string | null;
    panel_title: string | null;
    study_public_id: string | null;
    study_title: string | null;
    personas: InterviewProjectSummary["personas"] | string;
  }>(
    `select project.public_id, project.title, project.objective, project.status,
            project.created_at::text as created_at, project.updated_at::text as updated_at,
            count(distinct session.id)::int as session_count,
            panel.public_id as panel_public_id, panel.title as panel_title,
            study.public_id as study_public_id, study.title as study_title,
            coalesce(jsonb_agg(distinct jsonb_build_object(
              'publicId', persona.public_id, 'name', persona.name
            )) filter (where persona.id is not null), '[]'::jsonb) as personas
     from interview_projects project
     left join interview_sessions session on session.project_id = project.id
     left join interview_project_personas project_persona on project_persona.project_id = project.id
     left join study_personas persona on persona.id = project_persona.persona_id
     left join study_panels panel on panel.id = project.source_panel_id
     left join studies study on study.id = project.source_study_id
     where project.workspace_id = $1
     group by project.id, panel.id, study.id
     order by project.updated_at desc, project.id desc`,
    [viewer.workspaceId],
  );
  return result.rows.map((row) => ({
    publicId: row.public_id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
    panel: row.panel_public_id && row.panel_title ? { publicId: row.panel_public_id, title: row.panel_title } : null,
    study: row.study_public_id && row.study_title ? { publicId: row.study_public_id, title: row.study_title } : null,
    personas: parseJson(row.personas),
  }));
}

export async function getInterviewProject(viewer: Viewer, publicId: string): Promise<InterviewProjectDetail | null> {
  const database = await getDatabase();
  const projectResult = await database.query<{
    id: string;
    public_id: string;
    title: string;
    objective: string;
    status: InterviewProjectSummary["status"];
    created_at: string;
    updated_at: string;
    panel_public_id: string | null;
    panel_title: string | null;
    study_public_id: string | null;
    study_title: string | null;
  }>(
    `select project.id::text as id, project.public_id, project.title, project.objective, project.status,
            project.created_at::text as created_at, project.updated_at::text as updated_at,
            panel.public_id as panel_public_id, panel.title as panel_title,
            study.public_id as study_public_id, study.title as study_title
     from interview_projects project
     left join study_panels panel on panel.id = project.source_panel_id
     left join studies study on study.id = project.source_study_id
     where project.public_id = $1 and project.workspace_id = $2
     limit 1`,
    [publicId, viewer.workspaceId],
  );
  const project = projectResult.rows[0];
  if (!project) return null;
  const sessionsResult = await database.query<{
    session_id: string;
    session_public_id: string;
    status: InterviewSessionDetail["status"];
    summary: string;
    insights: string[] | string;
    quotes: string[] | string;
    session_type: "ai" | "human";
    participant_name: string | null;
    participant_email: string | null;
    persona_public_id: string | null;
    persona_name: string | null;
    archetype: string | null;
    profile: SyntheticPanelResearch["personas"][number] | string | null;
    messages: Array<{ id: string; role: "interviewer" | "persona"; content: string }> | string;
  }>(
    `select session.id::text as session_id, session.public_id as session_public_id,
            session.status, session.summary, session.insights, session.quotes,
            session.session_type, session.participant_name, session.participant_email,
            persona.public_id as persona_public_id, persona.name as persona_name,
            persona.archetype, persona.profile,
            coalesce(jsonb_agg(jsonb_build_object(
              'id', message.id::text, 'role', message.role, 'content', message.content
            ) order by message.turn_index) filter (where message.id is not null), '[]'::jsonb) as messages
     from interview_sessions session
     left join study_personas persona on persona.id = session.persona_id
     left join interview_messages message on message.session_id = session.id
     where session.project_id = $1
     group by session.id, persona.id
     order by session.created_at asc, session.id asc`,
    [project.id],
  );
  const sessions = sessionsResult.rows.map((session) => ({
    publicId: session.session_public_id,
    status: session.status,
    summary: session.summary,
    insights: parseJson(session.insights),
    quotes: parseJson(session.quotes),
    sessionType: session.session_type,
    participantName: session.participant_name ?? session.persona_name ?? "匿名参与者",
    participantEmail: session.participant_email,
    persona: session.persona_public_id && session.persona_name && session.archetype && session.profile ? {
      publicId: session.persona_public_id,
      name: session.persona_name,
      archetype: session.archetype,
      profile: parseJson(session.profile),
    } : null,
    messages: parseJson(session.messages),
  }));
  const [questionsResult, invitationsResult, runsResult, eventsResult, personasResult] = await Promise.all([
    database.query<{
      public_id: string;
      position: number;
      content: string;
      question_type: "open" | "single" | "multiple";
      options: string[] | string;
      ai_prompt: string | null;
      image_paths: string[] | string;
    }>(
      `select public_id, position, content, question_type, options, ai_prompt, image_paths
       from interview_questions where project_id = $1 order by position`,
      [project.id],
    ),
    database.query<{ public_id: string; token: string; expires_at: string | null; created_at: string }>(
      `select public_id, token, expires_at::text as expires_at, created_at::text as created_at
       from interview_invitations
       where project_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())
       order by created_at desc`,
      [project.id],
    ),
    database.query<{
      id: string;
      public_id: string;
      status: "queued" | "running" | "completed" | "failed" | "cancelled";
      provider: string | null;
      provider_model: string | null;
      error_message: string | null;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
      last_event_at: string | null;
    }>(
      `select run.id::text as id, run.public_id, run.status, run.provider, run.provider_model,
              run.error_message, run.created_at::text as created_at,
              run.started_at::text as started_at, run.finished_at::text as finished_at,
              (select max(event.created_at)::text from interview_events event where event.run_id = run.id) as last_event_at
       from interview_runs run where run.project_id = $1
       order by run.created_at asc, run.id asc`,
      [project.id],
    ),
    database.query<{
      id: string;
      run_id: string | null;
      event_type: string;
      payload: Record<string, unknown> | string;
      created_at: string;
    }>(
      `select id::text as id, run_id::text as run_id, event_type, payload, created_at::text as created_at
       from interview_events where project_id = $1 order by created_at, id`,
      [project.id],
    ),
    database.query<{ public_id: string; name: string }>(
      `select persona.public_id, persona.name
       from interview_project_personas selected
       join study_personas persona on persona.id = selected.persona_id
       where selected.project_id = $1 order by selected.position`,
      [project.id],
    ),
  ]);
  const questions = questionsResult.rows.map((question, index) => {
    const imagePaths = parseJson<string[]>(question.image_paths);
    return {
    publicId: question.public_id,
    index: question.position,
    question: question.content,
    questionType: question.question_type,
    options: parseJson(question.options),
    aiPrompt: question.ai_prompt,
    imagePaths,
    imageUrls: imagePaths.map(getInterviewImageUrl).filter(Boolean),
    answers: sessions.flatMap((session) => {
      const questionMessageIndex = session.messages.findIndex((candidate) => (
        candidate.role === "interviewer"
        && session.messages.filter((item) => item.role === "interviewer").indexOf(candidate) === index
      ));
      const answer = questionMessageIndex >= 0
        ? session.messages.slice(questionMessageIndex + 1).find((candidate) => candidate.role === "persona")
        : null;
      return answer ? [{
        personaPublicId: session.persona?.publicId ?? null,
        personaName: session.participantName,
        answer: answer.content,
      }] : [];
    }),
    };
  });
  const latestRun = runsResult.rows.at(-1) ?? null;
  const activeSince = latestRun?.last_event_at ?? latestRun?.started_at ?? latestRun?.created_at ?? null;
  const runRecoverable = (latestRun?.status === "queued" || latestRun?.status === "running")
    && activeSince !== null
    && Date.now() - new Date(activeSince).getTime() > 10 * 60 * 1000;
  return {
    publicId: project.public_id,
    title: project.title,
    objective: project.objective,
    status: project.status,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    sessionCount: sessions.length,
    panel: project.panel_public_id && project.panel_title ? { publicId: project.panel_public_id, title: project.panel_title } : null,
    study: project.study_public_id && project.study_title ? { publicId: project.study_public_id, title: project.study_title } : null,
    personas: personasResult.rows.map((persona) => ({ publicId: persona.public_id, name: persona.name })),
    runStatus: latestRun?.status ?? null,
    runError: latestRun?.error_message ?? null,
    runAttempt: runsResult.rows.length,
    runRecoverable,
    runEvents: eventsResult.rows
      .filter((event) => !latestRun || event.run_id === latestRun.id)
      .map((event) => ({
        id: event.id,
        type: event.event_type,
        payload: parseJson(event.payload),
        createdAt: event.created_at,
      })),
    runHistory: runsResult.rows.map((run, index) => ({
      publicId: run.public_id,
      attempt: index + 1,
      status: run.status,
      provider: run.provider,
      model: run.provider_model,
      error: run.error_message,
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
    })),
    sessions,
    questions,
    invitations: invitationsResult.rows.map((invitation) => ({
      publicId: invitation.public_id,
      token: invitation.token,
      expiresAt: invitation.expires_at,
      createdAt: invitation.created_at,
    })),
  };
}

export async function updateInterviewProjectStatus(
  viewer: Viewer,
  publicId: string,
  status: "completed" | "archived",
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query(
    `update interview_projects
     set status = $3, updated_at = now()
     where public_id = $1 and workspace_id = $2`,
    [publicId, viewer.workspaceId, status],
  );
  return result.rowCount ? "updated" as const : "not_found" as const;
}

export async function updateInterviewProjectDetails(viewer: Viewer, publicId: string, objective: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query(
    `update interview_projects set objective = $3, updated_at = now()
     where public_id = $1 and workspace_id = $2`,
    [publicId, viewer.workspaceId, objective],
  );
  return result.rowCount ? "updated" as const : "not_found" as const;
}

type InterviewQuestionInput = {
  content: string;
  questionType: "open" | "single" | "multiple";
  options: string[];
  aiPrompt?: string | null;
};

async function getOwnedProjectId(viewer: Viewer, publicId: string) {
  const database = await getDatabase();
  const result = await database.query<{ id: string }>(
    "select id::text as id from interview_projects where public_id = $1 and workspace_id = $2 limit 1",
    [publicId, viewer.workspaceId],
  );
  return result.rows[0]?.id ?? null;
}

export async function getInterviewQuestionImagePaths(viewer: Viewer, projectPublicId: string, questionPublicId?: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{ public_id: string; image_paths: string[] | string }>(
    `select question.public_id, question.image_paths
     from interview_questions question join interview_projects project on project.id = question.project_id
     where project.public_id = $1 and project.workspace_id = $2
       and ($3::text is null or question.public_id = $3)`,
    [projectPublicId, viewer.workspaceId, questionPublicId ?? null],
  );
  if (questionPublicId && !result.rowCount) return "not_found" as const;
  return result.rows.flatMap((row) => parseJson<string[]>(row.image_paths));
}

export async function createInterviewQuestion(viewer: Viewer, publicId: string, input: InterviewQuestionInput) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const projectId = await getOwnedProjectId(viewer, publicId);
  if (!projectId) return "not_found" as const;
  const database = await getDatabase();
  const result = await database.query<{ public_id: string }>(
    `insert into interview_questions (public_id, project_id, position, content, question_type, options, ai_prompt)
     select $1, $2, coalesce(max(position), 0) + 1, $3, $4, $5::jsonb, $6
     from interview_questions where project_id = $2
     returning public_id`,
    [createPublicId("inq"), projectId, input.content, input.questionType, JSON.stringify(input.options), input.aiPrompt ?? null],
  );
  await database.query("update interview_projects set updated_at = now() where id = $1", [projectId]);
  return { status: "created" as const, publicId: result.rows[0].public_id };
}

export async function updateInterviewQuestion(
  viewer: Viewer,
  projectPublicId: string,
  questionPublicId: string,
  input: InterviewQuestionInput,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query(
    `update interview_questions question
     set content = $4, question_type = $5, options = $6::jsonb, ai_prompt = $7, updated_at = now()
     from interview_projects project
     where question.project_id = project.id and project.public_id = $1 and project.workspace_id = $2
       and question.public_id = $3`,
    [projectPublicId, viewer.workspaceId, questionPublicId, input.content, input.questionType, JSON.stringify(input.options), input.aiPrompt ?? null],
  );
  return result.rowCount ? "updated" as const : "not_found" as const;
}

export async function addInterviewQuestionImage(
  viewer: Viewer,
  projectPublicId: string,
  questionPublicId: string,
  imagePath: string,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{ image_paths: string[] | string }>(
    `update interview_questions question
     set image_paths = image_paths || to_jsonb($4::text), updated_at = now()
     from interview_projects project
     where question.project_id = project.id and project.public_id = $1 and project.workspace_id = $2
       and question.public_id = $3 and jsonb_array_length(question.image_paths) < 4
     returning question.image_paths`,
    [projectPublicId, viewer.workspaceId, questionPublicId, imagePath],
  );
  if (!result.rowCount) {
    const exists = await database.query(
      `select 1 from interview_questions question join interview_projects project on project.id = question.project_id
       where project.public_id = $1 and project.workspace_id = $2 and question.public_id = $3`,
      [projectPublicId, viewer.workspaceId, questionPublicId],
    );
    return exists.rowCount ? "limit_reached" as const : "not_found" as const;
  }
  await database.query("update interview_projects set updated_at = now() where public_id = $1 and workspace_id = $2", [projectPublicId, viewer.workspaceId]);
  const imagePaths = parseJson<string[]>(result.rows[0].image_paths);
  return { status: "added" as const, imagePath, imageUrl: getInterviewImageUrl(imagePath), imagePaths };
}

export async function removeInterviewQuestionImage(
  viewer: Viewer,
  projectPublicId: string,
  questionPublicId: string,
  imagePath: string,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query(
    `update interview_questions question
     set image_paths = coalesce((
       select jsonb_agg(value order by ordinal)
       from jsonb_array_elements_text(question.image_paths) with ordinality as item(value, ordinal)
       where value <> $4
     ), '[]'::jsonb), updated_at = now()
     from interview_projects project
     where question.project_id = project.id and project.public_id = $1 and project.workspace_id = $2
       and question.public_id = $3 and question.image_paths ? $4`,
    [projectPublicId, viewer.workspaceId, questionPublicId, imagePath],
  );
  return result.rowCount ? "removed" as const : "not_found" as const;
}

export async function deleteInterviewQuestion(viewer: Viewer, projectPublicId: string, questionPublicId: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ project_id: string; image_paths: string[] | string }>(
      `delete from interview_questions question using interview_projects project
       where question.project_id = project.id and project.public_id = $1 and project.workspace_id = $2
         and question.public_id = $3 returning question.project_id::text as project_id, question.image_paths`,
      [projectPublicId, viewer.workspaceId, questionPublicId],
    );
    const projectId = result.rows[0]?.project_id;
    if (!projectId) return "not_found" as const;
    await transaction.query(
      `with ordered as (
         select id, row_number() over (order by position, id)::int as next_position
         from interview_questions where project_id = $1
       ) update interview_questions set position = ordered.next_position
         from ordered where interview_questions.id = ordered.id`,
      [projectId],
    );
    return { status: "deleted" as const, imagePaths: parseJson<string[]>(result.rows[0].image_paths) };
  });
}

export async function moveInterviewQuestion(
  viewer: Viewer,
  projectPublicId: string,
  questionPublicId: string,
  direction: "up" | "down",
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const currentResult = await transaction.query<{ id: string; project_id: string; position: number }>(
      `select question.id::text as id, question.project_id::text as project_id, question.position
       from interview_questions question join interview_projects project on project.id = question.project_id
       where project.public_id = $1 and project.workspace_id = $2 and question.public_id = $3 for update`,
      [projectPublicId, viewer.workspaceId, questionPublicId],
    );
    const current = currentResult.rows[0];
    if (!current) return "not_found" as const;
    const adjacentResult = await transaction.query<{ id: string; position: number }>(
      `select id::text as id, position from interview_questions
       where project_id = $1 and position ${direction === "up" ? "<" : ">"} $2
       order by position ${direction === "up" ? "desc" : "asc"} limit 1 for update`,
      [current.project_id, current.position],
    );
    const adjacent = adjacentResult.rows[0];
    if (!adjacent) return "unchanged" as const;
    const temporaryPositionResult = await transaction.query<{ position: number }>(
      "select coalesce(min(position), 0) - 1 as position from interview_questions where project_id = $1",
      [current.project_id],
    );
    const temporaryPosition = temporaryPositionResult.rows[0].position;
    await transaction.query("update interview_questions set position = $2 where id = $1", [current.id, temporaryPosition]);
    await transaction.query("update interview_questions set position = $2 where id = $1", [adjacent.id, current.position]);
    await transaction.query("update interview_questions set position = $2 where id = $1", [current.id, adjacent.position]);
    await transaction.query("update interview_projects set updated_at = now() where id = $1", [current.project_id]);
    return "moved" as const;
  });
}

export async function createInterviewInvitation(viewer: Viewer, publicId: string, durationDays: 1 | 3 | 7 | 30 | null) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const projectId = await getOwnedProjectId(viewer, publicId);
  if (!projectId) return "not_found" as const;
  const database = await getDatabase();
  const token = createPublicId("ivi");
  const result = await database.query<{ public_id: string; expires_at: string | null }>(
    `insert into interview_invitations (public_id, project_id, created_by, token, expires_at)
     values ($1, $2, $3, $4, case when $5::int is null then null else now() + make_interval(days => $5) end)
     returning public_id, expires_at::text as expires_at`,
    [createPublicId("inv"), projectId, viewer.userId, token, durationDays],
  );
  return { status: "created" as const, token, publicId: result.rows[0].public_id, expiresAt: result.rows[0].expires_at };
}

export async function revokeInterviewInvitation(viewer: Viewer, projectPublicId: string, invitationPublicId: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query(
    `update interview_invitations invitation set revoked_at = now()
     from interview_projects project
     where invitation.project_id = project.id and project.public_id = $1 and project.workspace_id = $2
       and invitation.public_id = $3 and invitation.revoked_at is null`,
    [projectPublicId, viewer.workspaceId, invitationPublicId],
  );
  return result.rowCount ? "revoked" as const : "not_found" as const;
}

export async function getPublicInterviewInvitation(token: string): Promise<PublicInterviewInvitation | null> {
  const database = await getDatabase();
  const invitationResult = await database.query<{
    token: string;
    title: string;
    objective: string;
    expires_at: string | null;
    project_id: string;
  }>(
    `select invitation.token, project.title, project.objective,
            invitation.expires_at::text as expires_at, project.id::text as project_id
     from interview_invitations invitation
     join interview_projects project on project.id = invitation.project_id
     where invitation.token = $1 and invitation.revoked_at is null
       and (invitation.expires_at is null or invitation.expires_at > now())
       and project.status <> 'archived'
     limit 1`,
    [token],
  );
  const invitation = invitationResult.rows[0];
  if (!invitation) return null;
  const questionsResult = await database.query<{
    public_id: string;
    position: number;
    content: string;
    question_type: "open" | "single" | "multiple";
    options: string[] | string;
    image_paths: string[] | string;
  }>(
    `select public_id, position, content, question_type, options, image_paths
     from interview_questions where project_id = $1 order by position`,
    [invitation.project_id],
  );
  return {
    token: invitation.token,
    projectTitle: invitation.title,
    objective: invitation.objective,
    expiresAt: invitation.expires_at,
    questions: questionsResult.rows.map((question) => ({
      publicId: question.public_id,
      index: question.position,
      content: question.content,
      questionType: question.question_type,
      options: parseJson(question.options),
      imageUrls: parseJson<string[]>(question.image_paths).map(getInterviewImageUrl).filter(Boolean),
    })),
  };
}

export async function submitPublicInterview(token: string, input: {
  participantName: string;
  participantEmail?: string;
  answers: Array<{ questionPublicId: string; answer: string | string[] }>;
}) {
  const database = await getDatabase();
  const invitationResult = await database.query<{ project_id: string }>(
    `select invitation.project_id::text as project_id
     from interview_invitations invitation
     join interview_projects project on project.id = invitation.project_id
     where invitation.token = $1 and invitation.revoked_at is null
       and (invitation.expires_at is null or invitation.expires_at > now())
       and project.status <> 'archived' limit 1`,
    [token],
  );
  const projectId = invitationResult.rows[0]?.project_id;
  if (!projectId) return "not_found" as const;
  const questionsResult = await database.query<{
    public_id: string;
    content: string;
    question_type: "open" | "single" | "multiple";
    options: string[] | string;
  }>(
    `select public_id, content, question_type, options
     from interview_questions where project_id = $1 order by position`,
    [projectId],
  );
  if (questionsResult.rows.length === 0 || questionsResult.rows.length !== input.answers.length) return "invalid_answers" as const;
  const answersByQuestion = new Map(input.answers.map((answer) => [answer.questionPublicId, answer.answer]));
  const valid = questionsResult.rows.every((question) => {
    const answer = answersByQuestion.get(question.public_id);
    if (answer === undefined) return false;
    if (question.question_type === "open") return typeof answer === "string" && answer.trim().length > 0;
    const selected = Array.isArray(answer) ? answer : [answer];
    const options = parseJson<string[]>(question.options);
    return selected.length > 0
      && (question.question_type === "multiple" || selected.length === 1)
      && selected.every((value) => options.includes(value));
  });
  if (!valid) return "invalid_answers" as const;
  const sessionPublicId = createPublicId("ins");
  await database.transaction(async (transaction) => {
    const sessionResult = await transaction.query<{ id: string }>(
      `insert into interview_sessions (
         public_id, project_id, persona_id, status, summary, insights, quotes,
         provider, session_type, participant_name, participant_email
       ) values ($1, $2, null, 'completed', $3, '[]'::jsonb, '[]'::jsonb, null, 'human', $4, $5)
       returning id::text as id`,
      [sessionPublicId, projectId, `${input.participantName} 完成了 ${questionsResult.rows.length} 个访谈问题。`, input.participantName, input.participantEmail || null],
    );
    let turnIndex = 0;
    for (const question of questionsResult.rows) {
      const answer = answersByQuestion.get(question.public_id);
      const answerText = Array.isArray(answer) ? answer.join("、") : answer ?? "";
      await transaction.query(
        `insert into interview_messages (session_id, turn_index, role, content)
         values ($1, $2, 'interviewer', $3), ($1, $4, 'persona', $5)`,
        [sessionResult.rows[0].id, turnIndex, question.content, turnIndex + 1, answerText],
      );
      turnIndex += 2;
    }
    await transaction.query(
      "update interview_projects set status = 'completed', updated_at = now() where id = $1",
      [projectId],
    );
  });
  return { status: "completed" as const, sessionPublicId };
}

export async function deleteInterviewProject(viewer: Viewer, publicId: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query(
    "delete from interview_projects where public_id = $1 and workspace_id = $2",
    [publicId, viewer.workspaceId],
  );
  return result.rowCount ? "deleted" as const : "not_found" as const;
}

export async function citeInterviewInsight(viewer: Viewer, publicId: string, input: {
  sessionPublicId: string;
  insight: string;
}) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{
    report_id: string | null;
    content_json: Record<string, unknown> | string | null;
    persona_name: string;
  }>(
    `select reports.id::text as report_id, reports.content_json, persona.name as persona_name
     from interview_projects project
     join interview_sessions session on session.project_id = project.id
     join study_personas persona on persona.id = session.persona_id
     left join reports on reports.study_id = project.source_study_id
     where project.public_id = $1 and project.workspace_id = $2 and session.public_id = $3
     limit 1`,
    [publicId, viewer.workspaceId, input.sessionPublicId],
  );
  const row = result.rows[0];
  if (!row) return "not_found" as const;
  if (!row.report_id || !row.content_json) return "report_missing" as const;
  const content = parseJson(row.content_json) as {
    findings?: Array<{ title: string; insight: string; evidence: string; implication: string }>;
    [key: string]: unknown;
  };
  const findings = Array.isArray(content.findings) ? content.findings : [];
  if (findings.some((finding) => finding.insight.trim() === input.insight)) return "duplicate" as const;
  content.findings = [...findings, {
    title: `模拟访谈洞察：${row.persona_name}`,
    insight: input.insight,
    evidence: `来自 AI 合成 Persona「${row.persona_name}」的结构化模拟访谈，不代表真人陈述或统计证据。`,
    implication: "将该洞察作为待验证假设，并结合真人访谈或行为数据进一步验证后再用于决策。",
  }];
  await database.query(
    "update reports set content_json = $2::jsonb, generated_at = now() where id = $1",
    [row.report_id, JSON.stringify(content)],
  );
  return "cited" as const;
}

export async function createInterviewProject(viewer: Viewer, input: CreateInterviewProjectInput) {
  const database = await getDatabase();
  const provider = getOpenAIProviderStatus();
  if (input.personaPublicIds.length > 0 && !provider.configured) throw new Error("PROVIDER_NOT_CONFIGURED");
  const personaResult = await database.query<{
    id: string;
    public_id: string;
    name: string;
    archetype: string;
    profile: SyntheticPanelResearch["personas"][number] | string;
  }>(
    `select id::text as id, public_id, name, archetype, profile
     from study_personas
     where workspace_id = $1 and public_id = any($2::text[])
       and (visibility = 'workspace' or created_by = $3)
     order by array_position($2::text[], public_id)`,
    [viewer.workspaceId, input.personaPublicIds, viewer.userId],
  );
  if (personaResult.rows.length !== new Set(input.personaPublicIds).size) throw new Error("PERSONA_NOT_FOUND");

  const [panelResult, studyResult] = await Promise.all([
    input.panelPublicId
      ? database.query<{ id: string }>(
        `select panel.id::text as id from study_panels panel
         join studies on studies.id = panel.study_id
         where panel.public_id = $1 and studies.workspace_id = $2 limit 1`,
        [input.panelPublicId, viewer.workspaceId],
      )
      : Promise.resolve({ rows: [] as Array<{ id: string }> }),
    input.studyPublicId
      ? database.query<{ id: string }>(
        "select id::text as id from studies where public_id = $1 and workspace_id = $2 limit 1",
        [input.studyPublicId, viewer.workspaceId],
      )
      : Promise.resolve({ rows: [] as Array<{ id: string }> }),
  ]);
  if (input.panelPublicId && !panelResult.rows[0]) throw new Error("PANEL_NOT_FOUND");
  if (input.studyPublicId && !studyResult.rows[0]) throw new Error("STUDY_NOT_FOUND");

  const publicId = createPublicId("int");
  await database.transaction(async (transaction) => {
    const projectResult = await transaction.query<{ id: string }>(
      `insert into interview_projects (
         public_id, workspace_id, created_by, title, objective, status, source_panel_id, source_study_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id::text as id`,
      [publicId, viewer.workspaceId, viewer.userId, input.title, input.objective, "active", panelResult.rows[0]?.id ?? null, studyResult.rows[0]?.id ?? null],
    );
    for (const [position, persona] of personaResult.rows.entries()) {
      await transaction.query(
        `insert into interview_project_personas (project_id, persona_id, position)
         values ($1, $2, $3)`,
        [projectResult.rows[0].id, persona.id, position],
      );
    }
    if (personaResult.rows.length > 0) {
      const runResult = await transaction.query<{ id: string }>(
        `insert into interview_runs (public_id, project_id, status, provider, provider_model)
         values ($1, $2, 'queued', $3, $4) returning id::text as id`,
        [createPublicId("irn"), projectResult.rows[0].id, provider.providerName, provider.researchModel],
      );
      await transaction.query(
        `insert into interview_events (project_id, run_id, event_type, payload)
         values ($1, $2, 'run.queued', $3::jsonb)`,
        [projectResult.rows[0].id, runResult.rows[0].id, JSON.stringify({
          provider: provider.providerName,
          model: provider.researchModel,
          personaCount: personaResult.rows.length,
        })],
      );
    }
  });
  return { publicId, queued: personaResult.rows.length > 0 };
}

export async function executeInterviewRun(publicId: string, workspaceId: string) {
  const database = await getDatabase();
  const provider = getOpenAIProviderStatus();
  const result = await database.query<{
    project_id: string;
    title: string;
    objective: string;
    user_public_id: string;
    run_id: string | null;
    run_status: string | null;
  }>(
    `select project.id::text as project_id, project.title, project.objective,
            creator.public_id as user_public_id, latest_run.id as run_id, latest_run.status as run_status
     from interview_projects project
     join users creator on creator.id = project.created_by
     left join lateral (
       select run.id::text as id, run.status
       from interview_runs run where run.project_id = project.id
       order by run.created_at desc, run.id desc limit 1
     ) latest_run on true
     where project.public_id = $1 and project.workspace_id = $2 limit 1`,
    [publicId, workspaceId],
  );
  const project = result.rows[0];
  if (!project || !project.run_id) return "not_found" as const;

  if (!provider.configured) {
    const message = "模型服务尚未配置，无法执行访谈。";
    await database.transaction(async (transaction) => {
      await transaction.query(
        `update interview_runs set status = 'failed', error_message = $2, finished_at = now()
         where id = $1 and status = 'queued'`,
        [project.run_id, message],
      );
      await transaction.query(
        `insert into interview_events (project_id, run_id, event_type, payload)
         values ($1, $2, 'run.failed', $3::jsonb)`,
        [project.project_id, project.run_id, JSON.stringify({ message, code: "PROVIDER_NOT_CONFIGURED" })],
      );
    });
    return "provider_missing" as const;
  }

  const claim = await database.query<{ id: string }>(
    `update interview_runs set status = 'running', provider = $2, provider_model = $3,
            started_at = now(), error_message = null
     where id = $1 and status = 'queued' returning id::text as id`,
    [project.run_id, provider.providerName, provider.researchModel],
  );
  if (!claim.rowCount) return project.run_status === "completed" ? "completed" as const : "already_running" as const;

  try {
    await database.query(
      `insert into interview_events (project_id, run_id, event_type, payload)
       values ($1, $2, 'run.started', $3::jsonb)`,
      [project.project_id, project.run_id, JSON.stringify({ provider: provider.providerName, model: provider.researchModel })],
    );
    const personasResult = await database.query<{
      id: string;
      public_id: string;
      name: string;
      archetype: string;
      profile: SyntheticPanelResearch["personas"][number] | string;
    }>(
      `select persona.id::text as id, persona.public_id, persona.name, persona.archetype, persona.profile
       from interview_project_personas selected
       join study_personas persona on persona.id = selected.persona_id
       where selected.project_id = $1 order by selected.position`,
      [project.project_id],
    );
    if (!personasResult.rowCount) throw new Error("PERSONA_NOT_FOUND");
    const personas = personasResult.rows.map((persona) => ({
      publicId: persona.public_id,
      name: persona.name,
      archetype: persona.archetype,
      profile: parseJson(persona.profile),
    }));
    await database.query(
      `insert into interview_events (project_id, run_id, event_type, payload)
       values ($1, $2, 'personas.loaded', $3::jsonb),
              ($1, $2, 'provider.request.started', $4::jsonb)`,
      [project.project_id, project.run_id, JSON.stringify({ personaCount: personas.length }), JSON.stringify({ provider: provider.providerName })],
    );
    const generated = await generateProviderSyntheticInterviews({
      title: project.title,
      objective: project.objective,
      personas,
      userPublicId: project.user_public_id,
    });
    await database.query(
      `insert into interview_events (project_id, run_id, event_type, payload)
       values ($1, $2, 'provider.response.received', $3::jsonb)`,
      [project.project_id, project.run_id, JSON.stringify({ model: generated.model, sessionCount: generated.sessions.length })],
    );
    const generatedByPersona = new Map(generated.sessions.map((session) => [session.personaPublicId, session]));
    const persisted = await database.transaction(async (transaction) => {
      const activeRun = await transaction.query(
        "select 1 from interview_runs where id = $1 and status = 'running' for update",
        [project.run_id],
      );
      if (!activeRun.rowCount) return false;
      const questionCount = await transaction.query<{ count: number }>(
        "select count(*)::int as count from interview_questions where project_id = $1",
        [project.project_id],
      );
      if (questionCount.rows[0].count === 0) {
        const questions = generated.sessions[0]?.messages.filter((message) => message.role === "interviewer") ?? [];
        for (const [index, question] of questions.entries()) {
          await transaction.query(
            `insert into interview_questions (public_id, project_id, position, content)
             values ($1, $2, $3, $4)`,
            [createPublicId("inq"), project.project_id, index + 1, question.content],
          );
        }
      }
      for (const persona of personasResult.rows) {
        const session = generatedByPersona.get(persona.public_id);
        if (!session) throw new Error("OPENAI_INVALID_SCHEMA");
        const sessionResult = await transaction.query<{ id: string }>(
          `insert into interview_sessions (
             public_id, project_id, persona_id, status, summary, insights, quotes, provider, provider_model
           ) values ($1, $2, $3, 'completed', $4, $5::jsonb, $6::jsonb, $7, $8)
           returning id::text as id`,
          [createPublicId("ins"), project.project_id, persona.id, session.summary, JSON.stringify(session.insights), JSON.stringify(session.quotes), provider.providerName, generated.model],
        );
        for (const [index, message] of session.messages.entries()) {
          await transaction.query(
            `insert into interview_messages (session_id, turn_index, role, content)
             values ($1, $2, $3, $4)`,
            [sessionResult.rows[0].id, index, message.role, message.content],
          );
        }
      }
      await transaction.query(
        `update interview_runs set status = 'completed', provider_response_id = $2,
                provider_model = $3, prompt_version = $4, finished_at = now()
         where id = $1`,
        [project.run_id, generated.responseId, generated.model, generated.promptVersion],
      );
      await transaction.query(
        "update interview_projects set status = 'completed', updated_at = now() where id = $1",
        [project.project_id],
      );
      await transaction.query(
        `insert into interview_events (project_id, run_id, event_type, payload)
         values ($1, $2, 'sessions.persisted', $3::jsonb),
                ($1, $2, 'run.completed', $4::jsonb)`,
        [project.project_id, project.run_id, JSON.stringify({ sessionCount: generated.sessions.length }), JSON.stringify({ sessionCount: generated.sessions.length })],
      );
      return true;
    });
    return persisted ? "completed" as const : "interrupted" as const;
  } catch (error) {
    const providerError = describeOpenAIError(error);
    await database.transaction(async (transaction) => {
      const failed = await transaction.query(
        `update interview_runs set status = 'failed', error_message = $2, finished_at = now()
         where id = $1 and status = 'running'`,
        [project.run_id, providerError.message],
      );
      if (failed.rowCount) {
        await transaction.query(
          `insert into interview_events (project_id, run_id, event_type, payload)
           values ($1, $2, 'run.failed', $3::jsonb)`,
          [project.project_id, project.run_id, JSON.stringify(providerError)],
        );
      }
    });
    return "failed" as const;
  }
}

export async function queueInterviewRun(viewer: Viewer, publicId: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const provider = getOpenAIProviderStatus();
  if (!provider.configured) return "provider_missing" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      project_id: string;
      persona_count: number;
      run_id: string | null;
      run_status: string | null;
      run_created_at: string | null;
      run_started_at: string | null;
      run_last_event_at: string | null;
    }>(
      `select project.id::text as project_id,
              (select count(*)::int from interview_project_personas selected where selected.project_id = project.id) as persona_count,
              latest_run.id as run_id, latest_run.status as run_status, latest_run.created_at::text as run_created_at,
              latest_run.started_at::text as run_started_at, latest_run.last_event_at::text as run_last_event_at
       from interview_projects project
       left join lateral (
         select run.id::text as id, run.status, run.created_at, run.started_at,
                (select max(event.created_at) from interview_events event where event.run_id = run.id) as last_event_at
         from interview_runs run where run.project_id = project.id
         order by run.created_at desc, run.id desc limit 1
       ) latest_run on true
       where project.public_id = $1 and project.workspace_id = $2
       for update of project`,
      [publicId, viewer.workspaceId],
    );
    const project = result.rows[0];
    if (!project) return "not_found" as const;
    if (!project.persona_count) return "no_personas" as const;
    if (project.run_status === "completed") return "completed" as const;
    const activeSince = project.run_last_event_at ?? project.run_started_at ?? project.run_created_at;
    const expired = (project.run_status === "queued" || project.run_status === "running")
      && activeSince !== null
      && Date.now() - new Date(activeSince).getTime() > 10 * 60 * 1000;
    if ((project.run_status === "queued" || project.run_status === "running") && !expired) return "already_running" as const;
    if (project.run_id && expired) {
      const message = "生成任务超过 10 分钟未更新，已记录为中断。";
      await transaction.query(
        `update interview_runs set status = 'failed', error_message = $2, finished_at = now()
         where id = $1 and status in ('queued', 'running')`,
        [project.run_id, message],
      );
      await transaction.query(
        `insert into interview_events (project_id, run_id, event_type, payload)
         values ($1, $2, 'run.interrupted', $3::jsonb)`,
        [project.project_id, project.run_id, JSON.stringify({ message, recoverable: true })],
      );
    }
    const runResult = await transaction.query<{ id: string }>(
      `insert into interview_runs (public_id, project_id, status, provider, provider_model)
       values ($1, $2, 'queued', $3, $4) returning id::text as id`,
      [createPublicId("irn"), project.project_id, provider.providerName, provider.researchModel],
    );
    await transaction.query(
      `insert into interview_events (project_id, run_id, event_type, payload)
       values ($1, $2, 'run.queued', $3::jsonb)`,
      [project.project_id, runResult.rows[0].id, JSON.stringify({ provider: provider.providerName, model: provider.researchModel })],
    );
    return "queued" as const;
  });
}
