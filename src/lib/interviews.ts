import type { Viewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { CreateInterviewProjectInput } from "@/lib/interview-schema";
import {
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
  persona: {
    publicId: string;
    name: string;
    archetype: string;
    profile: SyntheticPanelResearch["personas"][number];
  };
  messages: Array<{
    id: string;
    role: "interviewer" | "persona";
    content: string;
  }>;
};

export type InterviewProjectDetail = InterviewProjectSummary & {
  sessions: InterviewSessionDetail[];
  questions: Array<{
    index: number;
    question: string;
    answers: Array<{
      personaPublicId: string;
      personaName: string;
      answer: string;
    }>;
  }>;
};

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
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
     left join study_personas persona on persona.id = session.persona_id
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
    persona_public_id: string;
    persona_name: string;
    archetype: string;
    profile: SyntheticPanelResearch["personas"][number] | string;
    messages: Array<{ id: string; role: "interviewer" | "persona"; content: string }> | string;
  }>(
    `select session.id::text as session_id, session.public_id as session_public_id,
            session.status, session.summary, session.insights, session.quotes,
            persona.public_id as persona_public_id, persona.name as persona_name,
            persona.archetype, persona.profile,
            coalesce(jsonb_agg(jsonb_build_object(
              'id', message.id::text, 'role', message.role, 'content', message.content
            ) order by message.turn_index) filter (where message.id is not null), '[]'::jsonb) as messages
     from interview_sessions session
     join study_personas persona on persona.id = session.persona_id
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
    persona: {
      publicId: session.persona_public_id,
      name: session.persona_name,
      archetype: session.archetype,
      profile: parseJson(session.profile),
    },
    messages: parseJson(session.messages),
  }));
  const interviewerQuestions = sessions[0]?.messages.filter((message) => message.role === "interviewer") ?? [];
  const questions = interviewerQuestions.map((message, index) => ({
    index: index + 1,
    question: message.content,
    answers: sessions.flatMap((session) => {
      const questionMessageIndex = session.messages.findIndex((candidate) => (
        candidate.role === "interviewer"
        && session.messages.filter((item) => item.role === "interviewer").indexOf(candidate) === index
      ));
      const answer = questionMessageIndex >= 0
        ? session.messages.slice(questionMessageIndex + 1).find((candidate) => candidate.role === "persona")
        : null;
      return answer ? [{
        personaPublicId: session.persona.publicId,
        personaName: session.persona.name,
        answer: answer.content,
      }] : [];
    }),
  }));
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
    personas: sessions.map((session) => ({ publicId: session.persona.publicId, name: session.persona.name })),
    sessions,
    questions,
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

  const personas = personaResult.rows.map((persona) => ({
    publicId: persona.public_id,
    name: persona.name,
    archetype: persona.archetype,
    profile: parseJson(persona.profile),
  }));
  const generated = await generateProviderSyntheticInterviews({
    title: input.title,
    objective: input.objective,
    personas,
    userPublicId: viewer.userPublicId,
  });
  const generatedByPersona = new Map(generated.sessions.map((session) => [session.personaPublicId, session]));
  const publicId = createPublicId("int");
  await database.transaction(async (transaction) => {
    const projectResult = await transaction.query<{ id: string }>(
      `insert into interview_projects (
         public_id, workspace_id, created_by, title, objective, status, source_panel_id, source_study_id
       ) values ($1, $2, $3, $4, $5, 'completed', $6, $7) returning id::text as id`,
      [publicId, viewer.workspaceId, viewer.userId, input.title, input.objective, panelResult.rows[0]?.id ?? null, studyResult.rows[0]?.id ?? null],
    );
    for (const persona of personaResult.rows) {
      const generatedSession = generatedByPersona.get(persona.public_id);
      if (!generatedSession) throw new Error("OPENAI_INVALID_SCHEMA");
      const sessionResult = await transaction.query<{ id: string }>(
        `insert into interview_sessions (
           public_id, project_id, persona_id, status, summary, insights, quotes, provider, provider_model
         ) values ($1, $2, $3, 'completed', $4, $5::jsonb, $6::jsonb, $7, $8)
         returning id::text as id`,
        [createPublicId("ins"), projectResult.rows[0].id, persona.id, generatedSession.summary, JSON.stringify(generatedSession.insights), JSON.stringify(generatedSession.quotes), provider.providerName, generated.model],
      );
      for (const [index, message] of generatedSession.messages.entries()) {
        await transaction.query(
          `insert into interview_messages (session_id, turn_index, role, content)
           values ($1, $2, $3, $4)`,
          [sessionResult.rows[0].id, index, message.role, message.content],
        );
      }
    }
  });
  return publicId;
}
