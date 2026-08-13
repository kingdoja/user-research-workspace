import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { Viewer } from "@/lib/auth";
import {
  describeOpenAIError,
  generateProviderFollowupAnswer,
  generateProviderResearchReport,
  generateProviderStudyPlan,
  getOpenAIProviderStatus,
  type ResearchCitation,
  type ResearchProgressEvent,
  type ResearchReport,
  type SyntheticPanelResearch,
} from "@/lib/openai-provider";

export type StudyMethod = "Interview Chat" | "Discussion Chat" | "Scout Agent" | "Fast Insight";

export type ClarificationQuestion = {
  id: string;
  label: string;
  question: string;
  options: string[];
  maxSelect: number;
};

export type ClarificationAnswer = {
  questionId: string;
  selected: string[];
};

export type StudySummary = {
  publicId: string;
  title: string;
  status: string;
  currentStage: string;
  studyType: string;
  methods: StudyMethod[];
  updatedAt: string;
};

export type StudyDetail = StudySummary & {
  brief: string;
  estimatedTokens: number;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    partType: string;
    content: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  plan: {
    framework: string;
    methods: StudyMethod[];
    personaFilters: {
      audience: string;
      source: string;
    };
    personaCount: number;
    estimatedDurationMinutes: number;
    estimatedTokens: number;
    status: "draft" | "confirmed" | "rejected";
    source: "local_rules" | "openai";
    providerModel: string | null;
    rationale: string;
  };
  runStatus: string | null;
  runProvider: string | null;
  runModel: string | null;
  runError: string | null;
  runId: string | null;
  runAttempt: number | null;
  runCreatedAt: string | null;
  runStartedAt: string | null;
  runFinishedAt: string | null;
  runRecoverable: boolean;
  runHistory: Array<{
    id: string;
    attempt: number;
    status: string;
    provider: string | null;
    model: string | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    eventCount: number;
    completedSteps: number;
    totalSteps: number;
  }>;
  tasks: Array<{
    publicId: string;
    runId: string;
    key: string;
    title: string;
    toolName: string;
    status: "pending" | "running" | "completed" | "failed" | "skipped" | "waiting_input";
    position: number;
    dependsOn: string[];
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    error: string | null;
    attempt: number;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  artifacts: Array<{
    publicId: string;
    runId: string;
    taskKey: string | null;
    type: string;
    title: string;
    content: Record<string, unknown> | unknown[];
    createdAt: string;
    updatedAt: string;
  }>;
  clarification: {
    status: "not_required" | "pending" | "completed";
    questions: ClarificationQuestion[];
    answers: ClarificationAnswer[];
  };
  events: Array<{
    id: string;
    runId: string | null;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  personas: Array<{
    publicId: string;
    name: string;
    archetype: string;
    profile: SyntheticPanelResearch["personas"][number];
  }>;
  panel: {
    publicId: string;
    title: string;
    description: string;
  } | null;
  interviews: Array<{
    personaPublicId: string;
    personaName: string;
    batch: number;
    objective: string;
    content: SyntheticPanelResearch["interviews"][number];
  }>;
  report: {
    publicId: string;
    title: string;
    content: ResearchReport;
    citations: ResearchCitation[];
    generatedAt: string;
    shareEnabled: boolean;
    shareToken: string | null;
  } | null;
};

export type SharedStudyReport = {
  title: string;
  brief: string;
  generatedAt: string;
  report: NonNullable<StudyDetail["report"]>;
  panel: StudyDetail["panel"];
  personas: StudyDetail["personas"];
  interviews: StudyDetail["interviews"];
};

export type PanelDetail = {
  publicId: string;
  title: string;
  description: string;
  createdAt: string;
  sourceStudy: {
    publicId: string;
    title: string;
    brief: string;
  };
  personas: StudyDetail["personas"];
  interviews: StudyDetail["interviews"];
  projects: StudySummary[];
};

export type PersonaPanelUsage = {
  publicId: string;
  title: string;
};

export type PersonaLibraryItem = StudyDetail["personas"][number] & {
  source: "generated" | "manual";
  visibility: "private" | "workspace";
  createdAt: string;
  updatedAt: string;
  sourceStudy: { publicId: string; title: string } | null;
  panels: PersonaPanelUsage[];
  interviewCount: number;
  canEdit: boolean;
};

export type PersonaInput = {
  name: string;
  archetype: string;
  age: number;
  city: string;
  occupation: string;
  commute: string;
  budget: string;
  currentSituation: string;
  goals: string[];
  painPoints: string[];
  decisionStyle: string;
  tags: string[];
  visibility: "private" | "workspace";
  addToPanelPublicIds: string[];
};

async function appendStudyEvent(
  database: Awaited<ReturnType<typeof getDatabase>>,
  studyId: string,
  runId: string | null,
  type: string,
  payload: Record<string, unknown> = {},
) {
  await database.query(
    `insert into study_events (study_id, run_id, event_type, payload)
     values ($1, $2, $3, $4::jsonb)`,
    [studyId, runId, type, JSON.stringify(payload)],
  );
}

const titlePattern = /[。！？.!?\n]/;

function createStudyTitle(brief: string) {
  const firstSentence = brief.split(titlePattern)[0].trim();
  const normalized = firstSentence || "未命名研究";
  return normalized.length > 32 ? `${normalized.slice(0, 31)}…` : normalized;
}

function includesAny(brief: string, terms: string[]) {
  const normalized = brief.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function createClarificationQuestions(brief: string): ClarificationQuestion[] {
  const mobilityStudy = includesAny(brief, ["电动两轮", "电动车", "通勤", "续航", "换购"]);
  const productStudy = includesAny(brief, ["产品", "功能", "研发", "体验", "优化"]);

  return [
    {
      id: "business_goal",
      label: "研究目的",
      question: "这次研究主要需要支持哪类业务决策？",
      options: productStudy
        ? ["产品开发或功能优化", "产品定位与优先级", "营销策略与用户沟通", "市场机会与竞品对标"]
        : ["理解用户动机与痛点", "市场机会与竞品对标", "营销策略与用户沟通", "服务体验改进"],
      maxSelect: 1,
    },
    {
      id: "research_focus",
      label: "研究重点",
      question: "您更希望深入理解哪些方面？",
      options: mobilityStudy
        ? ["换购决策的完整路径", "续航预期与真实体验差距", "充电与换电场景限制", "品牌、价格与功能选择标准"]
        : ["完整决策路径", "核心痛点与未满足需求", "不同方案的比较标准", "使用体验与改进机会"],
      maxSelect: 2,
    },
    {
      id: "target_audience",
      label: "目标人群",
      question: "本次研究应优先覆盖哪类人群？",
      options: mobilityStudy
        ? ["一线城市上班族", "新一线与二线城市通勤者", "长距离高频骑行者", "近期正在换购的人群"]
        : ["现有用户", "近期购买或换购者", "潜在用户", "覆盖多个差异化细分群体"],
      maxSelect: 1,
    },
    {
      id: "research_scope",
      label: "证据范围",
      question: "您希望这次研究如何组合公开资料和 AI 合成 Persona？",
      options: [
        "公开资料 + AI 合成 Persona 模拟访谈",
        "仅使用公开资料，不做 Persona 模拟",
        "公开资料优先，并输出真人研究验证建议",
        "侧重行业政策、竞品与市场资料",
      ],
      maxSelect: 1,
    },
  ];
}

function formatClarificationAnswers(questions: ClarificationQuestion[], answers: ClarificationAnswer[]) {
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer.selected]));
  return questions.map((question) => (
    `${question.label}：${(answerMap.get(question.id) ?? []).join("、")}`
  )).join("\n");
}

export function derivePlan(brief: string) {
  const wantsFastInsight = includesAny(brief, ["播客", "快讯", "简报", "fast insight"]);
  const wantsPanelOnly = includesAny(brief, ["只做人设", "人设池", "panel only"]);
  const publicWebOnly = includesAny(brief, ["仅使用公开", "只使用公开", "公开网页", "公开资料", "公开信息"]);
  const wantsProductRAndD = includesAny(brief, ["市场进入", "机会", "趋势", "产品研发", "竞品"]);
  const needsScout = wantsProductRAndD || includesAny(brief, ["社交媒体", "小红书", "微博", "抖音", "舆情"]);
  const needsDiscussion = includesAny(brief, ["比较", "定位", "概念", "创意", "包装", "价格"]);
  const personaCount = includesAny(brief, ["多人", "细分", "对比", "群体"]) ? 8 : 5;

  const studyType = wantsFastInsight
    ? "fast_insight"
    : wantsPanelOnly
      ? "panel_only"
      : wantsProductRAndD
        ? "product_rnd"
        : "user_research";

  const framework = includesAny(brief, ["定位", "细分", "目标市场"])
    ? "STP"
    : includesAny(brief, ["流失", "动机", "为什么", "需求"])
      ? "Jobs To Be Done"
      : includesAny(brief, ["功能", "优先级", "满意"])
        ? "KANO"
        : includesAny(brief, ["旅程", "路径", "体验"])
          ? "用户旅程"
          : "探索式定性研究";

  const methods: StudyMethod[] = publicWebOnly
    ? ["Fast Insight"]
    : wantsFastInsight
    ? ["Fast Insight"]
    : wantsPanelOnly
      ? []
      : [
          ...(needsScout ? (["Scout Agent"] as StudyMethod[]) : []),
          ...(needsDiscussion ? (["Discussion Chat"] as StudyMethod[]) : []),
          "Interview Chat",
        ];

  const estimatedDurationMinutes = publicWebOnly || wantsFastInsight ? 180 : needsScout ? 2880 : 240;
  const estimatedTokens = publicWebOnly || wantsFastInsight ? 35000 : needsScout ? 120000 : personaCount * 12000;

  return {
    studyType,
    framework,
    methods,
    personaFilters: {
      audience: "由 Brief 与后续澄清确定",
      source: publicWebOnly
        ? "公开网页与可核查公共资料"
        : needsScout
          ? "公众人设库 + Scout 生成"
          : "公众人设库",
    },
    personaCount: publicWebOnly ? 1 : personaCount,
    estimatedDurationMinutes,
    estimatedTokens,
    rationale: publicWebOnly
      ? `根据 Brief 中的研究目标与公开资料约束，采用${framework}框架，只检索并综合可核查的公开网页，不执行或声称执行访谈、讨论及 Persona 模拟。`
      : `根据 Brief 中的研究目标与关键词，采用${framework}框架，并将研究范围控制在可验证的公开信息与后续待执行方法内。`,
  };
}

export async function createStudy(viewer: Viewer, briefInput: string, sourcePanelPublicId?: string) {
  const database = await getDatabase();
  const brief = briefInput.trim();
  const localPlan = {
    ...derivePlan(brief),
    source: "local_rules" as const,
    responseId: null,
    model: null,
    promptVersion: "clarification-draft-v1",
  };
  const questions = createClarificationQuestions(brief);
  const plan = localPlan;
  const publicId = createPublicId("std");
  const title = createStudyTitle(brief);

  return database.transaction(async (transaction) => {
    let sourcePanelId: string | null = null;

    if (sourcePanelPublicId) {
      const panelResult = await transaction.query<{ id: string }>(
        `select study_panels.id::text as id
         from study_panels
         join studies on studies.id = study_panels.study_id
         where study_panels.public_id = $1 and studies.workspace_id = $2
         limit 1`,
        [sourcePanelPublicId, viewer.workspaceId],
      );

      if (!panelResult.rows[0]) throw new Error("PANEL_NOT_FOUND");
      sourcePanelId = panelResult.rows[0].id;
    }

    const studyResult = await transaction.query<{ id: string }>(
      `insert into studies (
         public_id, workspace_id, created_by, title, brief, study_type, status,
         current_stage, estimated_tokens, source_panel_id
       ) values ($1, $2, $3, $4, $5, $6, 'planning', 'clarification', $7, $8)
       returning id::text as id`,
      [
        publicId,
        viewer.workspaceId,
        viewer.userId,
        title,
        brief,
        plan.studyType,
        plan.estimatedTokens,
        sourcePanelId,
      ],
    );
    const studyId = studyResult.rows[0].id;

    await transaction.query(
      `insert into study_plans (
         study_id, framework, methods, persona_filters, persona_count,
         estimated_duration_minutes, estimated_tokens, source,
         provider_response_id, provider_model, rationale
       ) values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)`,
      [
        studyId,
        plan.framework,
        JSON.stringify(plan.methods),
        JSON.stringify(plan.personaFilters),
        plan.personaCount,
        plan.estimatedDurationMinutes,
        plan.estimatedTokens,
        plan.source,
        plan.responseId,
        plan.model,
        plan.rationale,
      ],
    );

    await transaction.query(
      `insert into study_messages (study_id, role, content)
       values ($1, 'user', $2), ($1, 'assistant', $3)`,
      [
        studyId,
        brief,
        "我已完成初步意图分析。在生成研究计划前，需要确认业务目标、研究重点、目标人群和证据范围。",
      ],
    );

    await transaction.query(
      `insert into study_events (study_id, event_type, payload)
       values ($1, 'brief.analyzed', $2::jsonb),
              ($1, 'clarification.requested', $3::jsonb)`,
      [
        studyId,
        JSON.stringify({
          intent: plan.studyType,
          frameworkCandidate: plan.framework,
          audienceCandidate: plan.personaFilters.audience,
          requiresClarification: true,
        }),
        JSON.stringify({ questions }),
      ],
    );

    return publicId;
  });
}

export async function getPanel(viewer: Viewer, publicId: string): Promise<PanelDetail | null> {
  const database = await getDatabase();
  const panelResult = await database.query<{
    id: string;
    public_id: string;
    title: string;
    description: string;
    study_id: string;
    study_public_id: string;
    study_title: string;
    study_brief: string;
    created_at: string;
  }>(
    `select study_panels.id::text as id, study_panels.public_id, study_panels.title,
            study_panels.description, study_panels.study_id::text as study_id,
            studies.public_id as study_public_id, studies.title as study_title,
            studies.brief as study_brief, study_panels.created_at::text as created_at
     from study_panels
     join studies on studies.id = study_panels.study_id
     where study_panels.public_id = $1 and studies.workspace_id = $2
     limit 1`,
    [publicId, viewer.workspaceId],
  );
  const panel = panelResult.rows[0];
  if (!panel) return null;

  const [personasResult, interviewsResult, projectsResult] = await Promise.all([
    database.query<{
      public_id: string;
      name: string;
      archetype: string;
      profile: SyntheticPanelResearch["personas"][number] | string;
    }>(
      `select study_personas.public_id, study_personas.name, study_personas.archetype, study_personas.profile
       from study_panel_members
       join study_personas on study_personas.id = study_panel_members.persona_id
       where study_panel_members.panel_id = $1
       order by study_panel_members.position asc`,
      [panel.id],
    ),
    database.query<{
      persona_public_id: string;
      persona_name: string;
      batch: number;
      objective: string;
      content: SyntheticPanelResearch["interviews"][number] | string;
    }>(
      `select study_personas.public_id as persona_public_id, study_personas.name as persona_name,
              study_interviews.batch, study_interviews.objective, study_interviews.content
       from study_interviews
       join study_personas on study_personas.id = study_interviews.persona_id
       join study_panel_members on study_panel_members.persona_id = study_personas.id
       where study_panel_members.panel_id = $1
       order by study_interviews.batch asc, study_interviews.created_at asc, study_interviews.id asc`,
      [panel.id],
    ),
    database.query<{
      public_id: string;
      title: string;
      status: string;
      current_stage: string;
      study_type: string;
      methods: StudyMethod[] | string;
      updated_at: string;
    }>(
      `select studies.public_id, studies.title, studies.status, studies.current_stage,
              studies.study_type, coalesce(study_plans.methods, '[]'::jsonb) as methods,
              studies.updated_at::text as updated_at
       from studies
       left join study_plans on study_plans.study_id = studies.id
       where studies.id = $1 or studies.source_panel_id = $2
       order by studies.updated_at desc
       limit 20`,
      [panel.study_id, panel.id],
    ),
  ]);

  return {
    publicId: panel.public_id,
    title: panel.title,
    description: panel.description,
    createdAt: panel.created_at,
    sourceStudy: {
      publicId: panel.study_public_id,
      title: panel.study_title,
      brief: panel.study_brief,
    },
    personas: personasResult.rows.map((persona) => ({
      publicId: persona.public_id,
      name: persona.name,
      archetype: persona.archetype,
      profile: typeof persona.profile === "string" ? JSON.parse(persona.profile) : persona.profile,
    })),
    interviews: interviewsResult.rows.map((interview) => ({
      personaPublicId: interview.persona_public_id,
      personaName: interview.persona_name,
      batch: interview.batch,
      objective: interview.objective,
      content: typeof interview.content === "string" ? JSON.parse(interview.content) : interview.content,
    })),
    projects: projectsResult.rows.map((project) => ({
      publicId: project.public_id,
      title: project.title,
      status: project.status,
      currentStage: project.current_stage,
      studyType: project.study_type,
      methods: typeof project.methods === "string" ? JSON.parse(project.methods) : project.methods,
      updatedAt: project.updated_at,
    })),
  };
}

export async function listPersonas(viewer: Viewer): Promise<{
  personas: PersonaLibraryItem[];
  panels: PersonaPanelUsage[];
}> {
  const database = await getDatabase();
  const [personasResult, panelsResult] = await Promise.all([
    database.query<{
      public_id: string;
      name: string;
      archetype: string;
      profile: SyntheticPanelResearch["personas"][number] | string;
      source: PersonaLibraryItem["source"];
      visibility: PersonaLibraryItem["visibility"];
      created_at: string;
      updated_at: string;
      created_by: string;
      study_public_id: string | null;
      study_title: string | null;
      panels: PersonaPanelUsage[] | string;
      interview_count: number;
    }>(
      `select persona.public_id, persona.name, persona.archetype, persona.profile,
              persona.source, persona.visibility, persona.created_at::text as created_at,
              persona.updated_at::text as updated_at, persona.created_by::text as created_by,
              studies.public_id as study_public_id, studies.title as study_title,
              coalesce(jsonb_agg(distinct jsonb_build_object(
                'publicId', panels.public_id, 'title', panels.title
              )) filter (where panels.id is not null), '[]'::jsonb) as panels,
              (count(distinct interviews.id) + count(distinct workspace_interviews.id))::int as interview_count
       from study_personas persona
       left join studies on studies.id = persona.study_id
       left join study_panel_members members on members.persona_id = persona.id
       left join study_panels panels on panels.id = members.panel_id
       left join study_interviews interviews on interviews.persona_id = persona.id
       left join interview_sessions workspace_interviews on workspace_interviews.persona_id = persona.id
       where persona.workspace_id = $1
         and (persona.visibility = 'workspace' or persona.created_by = $2)
       group by persona.id, studies.public_id, studies.title
       order by persona.updated_at desc, persona.id desc`,
      [viewer.workspaceId, viewer.userId],
    ),
    database.query<{ public_id: string; title: string }>(
      `select study_panels.public_id, study_panels.title
       from study_panels
       join studies on studies.id = study_panels.study_id
       where studies.workspace_id = $1
       order by study_panels.created_at desc`,
      [viewer.workspaceId],
    ),
  ]);

  return {
    personas: personasResult.rows.map((persona) => ({
      publicId: persona.public_id,
      name: persona.name,
      archetype: persona.archetype,
      profile: typeof persona.profile === "string" ? JSON.parse(persona.profile) : persona.profile,
      source: persona.source,
      visibility: persona.visibility,
      createdAt: persona.created_at,
      updatedAt: persona.updated_at,
      sourceStudy: persona.study_public_id && persona.study_title
        ? { publicId: persona.study_public_id, title: persona.study_title }
        : null,
      panels: typeof persona.panels === "string" ? JSON.parse(persona.panels) : persona.panels,
      interviewCount: persona.interview_count,
      canEdit: persona.created_by === viewer.userId || viewer.role === "owner" || viewer.role === "admin",
    })),
    panels: panelsResult.rows.map((panel) => ({ publicId: panel.public_id, title: panel.title })),
  };
}

function toPersonaProfile(input: PersonaInput): SyntheticPanelResearch["personas"][number] {
  return {
    name: input.name.trim(),
    archetype: input.archetype.trim(),
    age: input.age,
    city: input.city.trim(),
    occupation: input.occupation.trim(),
    commute: input.commute.trim(),
    budget: input.budget.trim(),
    currentSituation: input.currentSituation.trim(),
    goals: input.goals.map((item) => item.trim()).filter(Boolean),
    painPoints: input.painPoints.map((item) => item.trim()).filter(Boolean),
    decisionStyle: input.decisionStyle.trim(),
    tags: input.tags.map((item) => item.trim()).filter(Boolean),
  };
}

async function resolvePanelIds(
  queryable: Parameters<Parameters<Awaited<ReturnType<typeof getDatabase>>["transaction"]>[0]>[0],
  viewer: Viewer,
  publicIds: string[],
) {
  if (!publicIds.length) return [];
  const result = await queryable.query<{ id: string }>(
    `select study_panels.id::text as id
     from study_panels
     join studies on studies.id = study_panels.study_id
     where studies.workspace_id = $1 and study_panels.public_id = any($2::text[])`,
    [viewer.workspaceId, publicIds],
  );
  if (result.rows.length !== new Set(publicIds).size) throw new Error("PANEL_NOT_FOUND");
  return result.rows.map((row) => row.id);
}

export async function createPersona(viewer: Viewer, input: PersonaInput) {
  const database = await getDatabase();
  const profile = toPersonaProfile(input);
  const publicId = createPublicId("per");

  await database.transaction(async (transaction) => {
    const panelIds = await resolvePanelIds(transaction, viewer, input.addToPanelPublicIds);
    const personaResult = await transaction.query<{ id: string }>(
      `insert into study_personas (
         public_id, workspace_id, created_by, name, archetype, profile, source, visibility
       ) values ($1, $2, $3, $4, $5, $6::jsonb, 'manual', $7)
       returning id::text as id`,
      [publicId, viewer.workspaceId, viewer.userId, profile.name, profile.archetype, JSON.stringify(profile), input.visibility],
    );
    for (const panelId of panelIds) {
      await transaction.query(
        `insert into study_panel_members (panel_id, persona_id, position)
         values ($1, $2, (select coalesce(max(position), -1) + 1 from study_panel_members where panel_id = $1))
         on conflict (panel_id, persona_id) do nothing`,
        [panelId, personaResult.rows[0].id],
      );
    }
  });
  return publicId;
}

export async function updatePersona(viewer: Viewer, publicId: string, input: PersonaInput) {
  const database = await getDatabase();
  const profile = toPersonaProfile(input);
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; created_by: string }>(
      `select id::text as id, created_by::text as created_by
       from study_personas where public_id = $1 and workspace_id = $2 for update`,
      [publicId, viewer.workspaceId],
    );
    const persona = result.rows[0];
    if (!persona) return "not_found" as const;
    const canEdit = persona.created_by === viewer.userId || viewer.role === "owner" || viewer.role === "admin";
    if (!canEdit) return "forbidden" as const;
    const panelIds = await resolvePanelIds(transaction, viewer, input.addToPanelPublicIds);
    await transaction.query(
      `update study_personas set name = $2, archetype = $3, profile = $4::jsonb,
              visibility = $5, updated_at = now() where id = $1`,
      [persona.id, profile.name, profile.archetype, JSON.stringify(profile), input.visibility],
    );
    for (const panelId of panelIds) {
      await transaction.query(
        `insert into study_panel_members (panel_id, persona_id, position)
         values ($1, $2, (select coalesce(max(position), -1) + 1 from study_panel_members where panel_id = $1))
         on conflict (panel_id, persona_id) do nothing`,
        [panelId, persona.id],
      );
    }
    return "updated" as const;
  });
}

export async function deletePersona(viewer: Viewer, publicId: string) {
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; created_by: string }>(
      `select id::text as id, created_by::text as created_by
       from study_personas
       where public_id = $1 and workspace_id = $2
       for update`,
      [publicId, viewer.workspaceId],
    );
    const persona = result.rows[0];
    if (!persona) return "not_found" as const;
    const canEdit = persona.created_by === viewer.userId || viewer.role === "owner" || viewer.role === "admin";
    if (!canEdit) return "forbidden" as const;
    const usageResult = await transaction.query<{ panel_count: number; interview_count: number }>(
      `select
         (select count(*)::int from study_panel_members where persona_id = $1) as panel_count,
         ((select count(*) from study_interviews where persona_id = $1)
          + (select count(*) from interview_sessions where persona_id = $1))::int as interview_count`,
      [persona.id],
    );
    const usage = usageResult.rows[0];
    if (usage.panel_count > 0 || usage.interview_count > 0) return "in_use" as const;
    await transaction.query("delete from study_personas where id = $1", [persona.id]);
    return "deleted" as const;
  });
}

export async function submitStudyClarification(
  viewer: Viewer,
  publicId: string,
  answers: ClarificationAnswer[],
) {
  const database = await getDatabase();
  const result = await database.query<{
    id: string;
    brief: string;
    plan_status: string;
    completed: boolean;
    questions_payload: { questions?: ClarificationQuestion[] } | string | null;
  }>(
    `select studies.id::text as id, studies.brief, study_plans.status as plan_status,
       exists (
         select 1 from study_events completed
         where completed.study_id = studies.id and completed.event_type = 'clarification.completed'
       ) as completed,
       requested.payload as questions_payload
     from studies
     join study_plans on study_plans.study_id = studies.id
     left join lateral (
       select payload from study_events
       where study_id = studies.id and event_type = 'clarification.requested'
       order by created_at desc, id desc limit 1
     ) requested on true
     where studies.public_id = $1 and studies.workspace_id = $2
     limit 1`,
    [publicId, viewer.workspaceId],
  );
  const study = result.rows[0];

  if (!study) return "not_found" as const;
  if (study.plan_status === "confirmed") return "already_confirmed" as const;
  if (study.completed) return "already_completed" as const;

  const payload = typeof study.questions_payload === "string"
    ? JSON.parse(study.questions_payload)
    : study.questions_payload;
  const questions: ClarificationQuestion[] = Array.isArray(payload?.questions)
    ? payload.questions
    : [];
  const answersById = new Map(answers.map((answer) => [answer.questionId, answer.selected]));
  const valid = questions.length > 0 && questions.every((question) => {
    const selected = answersById.get(question.id) ?? [];
    return selected.length >= 1
      && selected.length <= question.maxSelect
      && selected.every((option) => question.options.includes(option));
  });

  if (!valid) return "invalid_answers" as const;

  const clarificationContext = formatClarificationAnswers(questions, answers);
  const providerStatus = getOpenAIProviderStatus();
  let providerFailure: ReturnType<typeof describeOpenAIError> | null = null;
  let providerPlan: Awaited<ReturnType<typeof generateProviderStudyPlan>> | null = null;

  if (providerStatus.configured) {
    try {
      providerPlan = await generateProviderStudyPlan(study.brief, viewer.userPublicId, clarificationContext);
    } catch (error) {
      providerFailure = describeOpenAIError(error);
    }
  }

  const enrichedBrief = `${study.brief}\n${clarificationContext}`;
  const plan = providerPlan ?? {
    ...derivePlan(enrichedBrief),
    source: "local_rules" as const,
    responseId: null,
    model: null,
    promptVersion: "clarified-local-plan-v1",
  };

  await database.transaction(async (transaction) => {
    const lock = await transaction.query<{ completed: boolean }>(
      `select exists (
         select 1 from study_events
         where study_id = studies.id and event_type = 'clarification.completed'
       ) as completed
       from studies
       where id = $1 for update`,
      [study.id],
    );
    if (lock.rows[0]?.completed) return;

    await transaction.query(
      `update study_plans set
         version = version + 1, framework = $2, methods = $3::jsonb,
         persona_filters = $4::jsonb, persona_count = $5,
         estimated_duration_minutes = $6, estimated_tokens = $7,
         source = $8, provider_response_id = $9, provider_model = $10,
         rationale = $11, updated_at = now()
       where study_id = $1`,
      [
        study.id, plan.framework, JSON.stringify(plan.methods),
        JSON.stringify(plan.personaFilters), plan.personaCount,
        plan.estimatedDurationMinutes, plan.estimatedTokens, plan.source,
        plan.responseId, plan.model, plan.rationale,
      ],
    );
    await transaction.query(
      `update studies set study_type = $2, status = 'awaiting_confirmation',
         current_stage = 'confirmation', estimated_tokens = $3, updated_at = now()
       where id = $1`,
      [study.id, plan.studyType, plan.estimatedTokens],
    );
    await transaction.query(
      `insert into study_messages (study_id, role, content, payload)
       values ($1, 'user', $2, $3::jsonb),
              ($1, 'assistant', $4, $5::jsonb)`,
      [
        study.id,
        clarificationContext,
        JSON.stringify({ answers }),
        "已收到澄清信息，并据此生成了可确认的研究计划。",
        JSON.stringify({ source: plan.source, model: plan.model }),
      ],
    );
    await transaction.query(
      `insert into study_events (study_id, event_type, payload)
       values ($1, 'clarification.completed', $2::jsonb),
              ($1, 'plan.created', $3::jsonb)`,
      [
        study.id,
        JSON.stringify({ answers, summary: clarificationContext }),
        JSON.stringify({
          source: plan.source,
          promptVersion: plan.promptVersion,
          responseId: plan.responseId,
          model: plan.model,
          fallbackError: providerFailure,
        }),
      ],
    );
  });

  return "completed" as const;
}

export async function submitStudyFollowup(viewer: Viewer, publicId: string, questionInput: string) {
  const database = await getDatabase();
  const question = questionInput.trim();
  const result = await database.query<{
    study_id: string;
    report_content: (ResearchReport & { citations?: ResearchCitation[] }) | string | null;
  }>(
    `select studies.id::text as study_id, reports.content_json as report_content
     from studies
     left join reports on reports.study_id = studies.id
     where studies.public_id = $1 and studies.workspace_id = $2 and studies.status = 'completed'
     limit 1`,
    [publicId, viewer.workspaceId],
  );
  const study = result.rows[0];
  if (!study) return "not_found" as const;
  if (!study.report_content) return "report_missing" as const;

  const reportContent: ResearchReport & { citations?: ResearchCitation[] } = typeof study.report_content === "string"
    ? JSON.parse(study.report_content)
    : study.report_content;
  const citations: ResearchCitation[] = reportContent.citations ?? [];
  const conversationResult = await database.query<{
    role: "user" | "assistant";
    content: string | null;
  }>(
    `select role, content from study_messages
     where study_id = $1 and part_type in ('followup_question', 'followup_answer')
     order by created_at desc, id desc limit 6`,
    [study.study_id],
  );

  let providerFailure: ReturnType<typeof describeOpenAIError> | null = null;
  let answer: Awaited<ReturnType<typeof generateProviderFollowupAnswer>>;
  try {
    answer = await generateProviderFollowupAnswer({
      question,
      report: reportContent,
      citations,
      conversation: conversationResult.rows.reverse().map((message) => ({
        role: message.role,
        content: message.content ?? "",
      })),
      userPublicId: viewer.userPublicId,
      studyPublicId: publicId,
    });
  } catch (error) {
    providerFailure = describeOpenAIError(error);
    const evidence = reportContent.findings.slice(0, 3).map((finding, index) => (
      `${index + 1}. ${finding.title}：${finding.insight} 报告中的证据说明为：${finding.evidence}`
    ));
    const recommendations = reportContent.recommendations.slice(0, 3).map((recommendation, index) => (
      `${index + 1}. ${recommendation.title}：${recommendation.action}`
    ));
    answer = {
      answer: [
        `针对“${question}”，当前只能依据这份已生成报告回答。`,
        `报告证据：\n${evidence.join("\n")}`,
        `分析与建议：\n${recommendations.join("\n")}`,
        `仍需验证：\n${reportContent.limitations.join("\n")}`,
      ].join("\n\n"),
      citations: citations.map((citation) => citation.url).slice(0, 5),
      caveat: `上游模型暂时不可用，本回答由报告内容自动整理，没有新增检索、真人访谈或统计证据。${providerFailure.message}`,
      responseId: `local_${createPublicId("rsp")}`,
      model: "local-report-fallback",
      promptVersion: "report-followup-fallback-v1",
    };
  }

  const citationDetails = answer.citations.flatMap((url) => {
    const citation = citations.find((item) => item.url === url);
    return citation ? [citation] : [];
  });

  await database.transaction(async (transaction) => {
    await transaction.query(
      `insert into study_messages (study_id, role, part_type, content, payload)
       values ($1, 'user', 'followup_question', $2, '{}'::jsonb),
              ($1, 'assistant', 'followup_answer', $3, $4::jsonb)`,
      [study.study_id, question, answer.answer, JSON.stringify({
        caveat: answer.caveat,
        citations: citationDetails,
        responseId: answer.responseId,
        model: answer.model,
        promptVersion: answer.promptVersion,
        providerFailure,
      })],
    );
    await transaction.query(
      `insert into study_events (study_id, event_type, payload)
       values ($1, 'followup.answered', $2::jsonb)`,
      [study.study_id, JSON.stringify({ citationCount: citationDetails.length, model: answer.model })],
    );
    await transaction.query("update studies set updated_at = now() where id = $1", [study.study_id]);
  });

  return "completed" as const;
}

export async function updateStudyShare(viewer: Viewer, publicId: string, enabled: boolean) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  const shareToken = enabled ? createPublicId("shr") : null;
  const result = await database.query<{ share_token: string | null }>(
    `update reports
     set share_enabled = $3,
         share_token = case
           when $3 and share_token is not null then share_token
           when $3 then $4
           else null
         end
     from studies
     where reports.study_id = studies.id
       and studies.public_id = $1
       and studies.workspace_id = $2
       and studies.status = 'completed'
     returning reports.share_token`,
    [publicId, viewer.workspaceId, enabled, shareToken],
  );

  if (!result.rows[0]) return "not_found" as const;

  await database.query(
    `insert into study_events (study_id, event_type, payload)
     select id, $3, $4::jsonb from studies where public_id = $1 and workspace_id = $2`,
    [
      publicId,
      viewer.workspaceId,
      enabled ? "report.share.enabled" : "report.share.disabled",
      JSON.stringify({ enabled }),
    ],
  );

  return { status: "updated" as const, shareToken: result.rows[0].share_token };
}

export async function getSharedStudyReport(shareToken: string): Promise<SharedStudyReport | null> {
  const database = await getDatabase();
  const result = await database.query<{
    study_id: string;
    title: string;
    brief: string;
    report_public_id: string;
    report_title: string;
    report_content: (ResearchReport & { citations?: ResearchCitation[] }) | string;
    report_generated_at: string;
  }>(
    `select studies.id::text as study_id, studies.title, studies.brief,
       reports.public_id as report_public_id, reports.title as report_title,
       reports.content_json as report_content, reports.generated_at::text as report_generated_at
     from reports
     join studies on studies.id = reports.study_id
     where reports.share_enabled = true and reports.share_token = $1 and studies.status = 'completed'
     limit 1`,
    [shareToken],
  );
  const row = result.rows[0];
  if (!row) return null;

  const [personasResult, panelResult, interviewsResult] = await Promise.all([
    database.query<{
      public_id: string;
      name: string;
      archetype: string;
      profile: SyntheticPanelResearch["personas"][number] | string;
    }>(
      `select public_id, name, archetype, profile from study_personas
       where study_id = $1 order by created_at asc, id asc`,
      [row.study_id],
    ),
    database.query<{ public_id: string; title: string; description: string }>(
      `select public_id, title, description from study_panels
       where study_id = $1 order by created_at desc, id desc limit 1`,
      [row.study_id],
    ),
    database.query<{
      persona_public_id: string;
      persona_name: string;
      batch: number;
      objective: string;
      content: SyntheticPanelResearch["interviews"][number] | string;
    }>(
      `select p.public_id as persona_public_id, p.name as persona_name,
              i.batch, i.objective, i.content
       from study_interviews i
       join study_personas p on p.id = i.persona_id
       where i.study_id = $1 order by i.batch asc, i.created_at asc, i.id asc`,
      [row.study_id],
    ),
  ]);
  const reportContent = typeof row.report_content === "string"
    ? JSON.parse(row.report_content)
    : row.report_content;

  return {
    title: row.title,
    brief: row.brief,
    generatedAt: row.report_generated_at,
    report: {
      publicId: row.report_public_id,
      title: row.report_title,
      content: reportContent,
      citations: reportContent.citations ?? [],
      generatedAt: row.report_generated_at,
      shareEnabled: true,
      shareToken,
    },
    panel: panelResult.rows[0]
      ? {
          publicId: panelResult.rows[0].public_id,
          title: panelResult.rows[0].title,
          description: panelResult.rows[0].description,
        }
      : null,
    personas: personasResult.rows.map((persona) => ({
      publicId: persona.public_id,
      name: persona.name,
      archetype: persona.archetype,
      profile: typeof persona.profile === "string" ? JSON.parse(persona.profile) : persona.profile,
    })),
    interviews: interviewsResult.rows.map((interview) => ({
      personaPublicId: interview.persona_public_id,
      personaName: interview.persona_name,
      batch: interview.batch,
      objective: interview.objective,
      content: typeof interview.content === "string" ? JSON.parse(interview.content) : interview.content,
    })),
  };
}

export async function confirmStudyPlan(viewer: Viewer, publicId: string) {
  const database = await getDatabase();

  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; plan_status: string }>(
      `select studies.id::text as id, study_plans.status as plan_status
       from studies
       join study_plans on study_plans.study_id = studies.id
       where studies.public_id = $1 and studies.workspace_id = $2
       for update`,
      [publicId, viewer.workspaceId],
    );
    const study = result.rows[0];

    if (!study) {
      return "not_found" as const;
    }

    if (study.plan_status === "confirmed") {
      return "already_confirmed" as const;
    }

    await transaction.query(
      "update study_plans set status = 'confirmed', confirmed_at = now(), updated_at = now() where study_id = $1",
      [study.id],
    );
    await transaction.query(
      `update studies
       set status = 'queued', current_stage = 'execution', updated_at = now()
       where id = $1`,
      [study.id],
    );
    const runResult = await transaction.query<{ id: string }>(
      `insert into study_runs (study_id, status)
       values ($1, 'awaiting_provider')
       returning id::text as id`,
      [study.id],
    );
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type)
       values ($1, $2, 'plan.confirmed')`,
      [study.id, runResult.rows[0].id],
    );

    return "confirmed" as const;
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderReportHtml(report: ResearchReport) {
  const findings = report.findings.map((finding) => (
    `<section><h2>${escapeHtml(finding.title)}</h2><p>${escapeHtml(finding.insight)}</p>`
      + `<h3>证据</h3><p>${escapeHtml(finding.evidence)}</p>`
      + `<h3>业务含义</h3><p>${escapeHtml(finding.implication)}</p></section>`
  )).join("");
  const recommendations = report.recommendations.map((item) => (
    `<li><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.action)}</p>`
      + `<p>${escapeHtml(item.rationale)}</p></li>`
  )).join("");

  return `<article><h1>${escapeHtml(report.title)}</h1><p>${escapeHtml(report.executiveSummary)}</p>`
    + `${findings}<section><h2>行动建议</h2><ol>${recommendations}</ol></section></article>`;
}

function getTotalTokens(usage: unknown) {
  if (!usage || typeof usage !== "object" || !("total_tokens" in usage)) {
    return 0;
  }

  return typeof usage.total_tokens === "number" ? usage.total_tokens : 0;
}

export async function executeStudyRun(publicId: string, workspaceId: string) {
  const database = await getDatabase();
  const providerStatus = getOpenAIProviderStatus();
  const result = await database.query<{
    study_id: string;
    brief: string;
    framework: string;
    methods: StudyMethod[] | string;
    persona_filters: StudyDetail["plan"]["personaFilters"] | string;
    user_public_id: string;
    created_by: string;
    run_id: string | null;
    run_status: string | null;
  }>(
    `select
       studies.id::text as study_id,
       studies.brief,
       study_plans.framework,
       study_plans.methods,
       study_plans.persona_filters,
       users.public_id as user_public_id,
       studies.created_by::text as created_by,
       latest_run.id as run_id,
       latest_run.status as run_status
     from studies
     join study_plans on study_plans.study_id = studies.id
     join users on users.id = studies.created_by
     left join lateral (
       select study_runs.id::text as id, study_runs.status
       from study_runs
       where study_runs.study_id = studies.id
       order by study_runs.created_at desc, study_runs.id desc
       limit 1
     ) latest_run on true
     where studies.public_id = $1 and studies.workspace_id = $2
     limit 1`,
    [publicId, workspaceId],
  );
  const study = result.rows[0];

  if (!study || !study.run_id) {
    return "not_found" as const;
  }

  if (!providerStatus.configured) {
    await database.query(
      `insert into study_events (study_id, event_type, payload)
       select $1, 'provider.configuration_missing', $2::jsonb
       where not exists (
         select 1 from study_events
         where study_id = $1 and event_type = 'provider.configuration_missing'
       )`,
      [study.study_id, JSON.stringify({ provider: providerStatus.providerName, requiredVariable: "OPENAI_API_KEY" })],
    );
    return "provider_missing" as const;
  }

  const claim = await database.query<{ id: string }>(
    `update study_runs
     set status = 'running', provider = $2, provider_model = $3, started_at = now(), error_message = null
     where id = $1 and status in ('awaiting_provider', 'queued')
     returning id::text as id`,
    [study.run_id, providerStatus.providerName, providerStatus.researchModel],
  );

  if (claim.rows.length === 0) {
    return study.run_status === "completed" ? "completed" as const : "already_running" as const;
  }

  await database.query(
    `update studies set status = 'running', current_stage = 'execution', updated_at = now() where id = $1`,
    [study.study_id],
  );
  await database.query(
    `insert into study_events (study_id, run_id, event_type, payload)
     values ($1, $2, 'run.started', $3::jsonb)`,
    [study.study_id, study.run_id, JSON.stringify({ provider: providerStatus.providerName, model: providerStatus.researchModel })],
  );

  const methods = typeof study.methods === "string" ? JSON.parse(study.methods) : study.methods;
  const personaFilters = typeof study.persona_filters === "string"
    ? JSON.parse(study.persona_filters)
    : study.persona_filters;

  try {
    const providerResult = await generateProviderResearchReport({
      brief: study.brief,
      framework: study.framework,
      methods,
      audience: personaFilters.audience,
      userPublicId: study.user_public_id,
      studyPublicId: publicId,
      onProgress: async (event: ResearchProgressEvent) => {
        await appendStudyEvent(database, study.study_id, study.run_id, event.type, event.payload);
      },
    });
    const reportPublicId = createPublicId("rpt");
    const contentJson = { ...providerResult.report, citations: providerResult.citations };
    const totalTokens = getTotalTokens(providerResult.usage);

    await database.transaction(async (transaction) => {
      const personaIdsByName = new Map<string, string>();

      for (const persona of providerResult.panelResearch.personas) {
        const personaResult = await transaction.query<{ id: string }>(
          `insert into study_personas (
             public_id, workspace_id, created_by, study_id, run_id, name, archetype, profile
           ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           returning id::text as id`,
          [
            createPublicId("per"), workspaceId, study.created_by, study.study_id, study.run_id,
            persona.name, persona.archetype, JSON.stringify(persona),
          ],
        );
        personaIdsByName.set(persona.name, personaResult.rows[0].id);
      }

      const panelResult = await transaction.query<{ id: string }>(
        `insert into study_panels (public_id, study_id, run_id, title, description)
         values ($1, $2, $3, $4, $5)
         returning id::text as id`,
        [
          createPublicId("pnl"), study.study_id, study.run_id,
          providerResult.panelResearch.panel.title,
          providerResult.panelResearch.panel.description,
        ],
      );

      for (const [position, persona] of providerResult.panelResearch.personas.entries()) {
        const personaId = personaIdsByName.get(persona.name);
        if (!personaId) continue;
        await transaction.query(
          "insert into study_panel_members (panel_id, persona_id, position) values ($1, $2, $3)",
          [panelResult.rows[0].id, personaId, position],
        );
      }

      for (const interview of providerResult.panelResearch.interviews) {
        const personaId = personaIdsByName.get(interview.personaName);
        if (!personaId) continue;
        await transaction.query(
          `insert into study_interviews (study_id, run_id, persona_id, batch, objective, content)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            study.study_id, study.run_id, personaId, interview.batch,
            interview.objective, JSON.stringify(interview),
          ],
        );
      }

      await transaction.query(
        `insert into reports (public_id, study_id, title, description, content_html, content_json)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (study_id) do update set
           title = excluded.title,
           description = excluded.description,
           content_html = excluded.content_html,
           content_json = excluded.content_json,
           generated_at = now()`,
        [
          reportPublicId,
          study.study_id,
          providerResult.report.title,
          providerResult.report.executiveSummary,
          renderReportHtml(providerResult.report),
          JSON.stringify(contentJson),
        ],
      );
      await transaction.query(
        `update study_runs
         set status = 'completed', provider_response_id = $2, provider_model = $3,
             prompt_version = $4, usage = $5::jsonb, finished_at = now()
         where id = $1`,
        [
          study.run_id,
          providerResult.responseId,
          providerResult.model,
          providerResult.promptVersion,
          JSON.stringify(providerResult.usage ?? {}),
        ],
      );
      await transaction.query(
        `update studies
         set status = 'completed', current_stage = 'report', consumed_tokens = $2, updated_at = now()
         where id = $1`,
        [study.study_id, totalTokens],
      );
      await transaction.query(
        `insert into study_events (study_id, run_id, event_type, payload)
         values ($1, $2, 'report.generated', $3::jsonb),
                ($1, $2, 'research.completed', $4::jsonb)`,
        [study.study_id, study.run_id, JSON.stringify({
          provider: providerStatus.providerName,
          responseId: providerResult.responseId,
          model: providerResult.model,
          promptVersion: providerResult.promptVersion,
          citationCount: providerResult.citations.length,
          findingCount: providerResult.report.findings.length,
          recommendationCount: providerResult.report.recommendations.length,
          totalTokens,
        }), JSON.stringify({
          completedSteps: 9,
          outputCount: 1,
          panelCount: providerResult.panelResearch.personas.length,
        })],
      );
      await transaction.query(
        `insert into study_messages (study_id, role, content, payload)
         values ($1, 'assistant', $2, $3::jsonb)`,
        [
          study.study_id,
          "公开网页研究已完成。报告包含可核查来源、关键洞察、行动建议与研究局限。",
          JSON.stringify({ reportPublicId, responseId: providerResult.responseId }),
        ],
      );
    });

    return "completed" as const;
  } catch (error) {
    const providerError = describeOpenAIError(error);

    await database.transaction(async (transaction) => {
      await transaction.query(
        `update study_runs
         set status = 'failed', error_message = $2, finished_at = now()
         where id = $1`,
        [study.run_id, providerError.message],
      );
      await transaction.query(
        `update studies set status = 'failed', current_stage = 'execution', updated_at = now() where id = $1`,
        [study.study_id],
      );
      await transaction.query(
        `insert into study_events (study_id, run_id, event_type, payload)
         values ($1, $2, 'run.failed', $3::jsonb)`,
        [study.study_id, study.run_id, JSON.stringify(providerError)],
      );
      await transaction.query(
        `insert into study_messages (study_id, role, content)
         values ($1, 'assistant', $2)`,
        [study.study_id, "研究执行未完成。错误已记录，可以在修复配置后重新启动。"],
      );
    });

    return "failed" as const;
  }
}

export async function queueStudyRun(viewer: Viewer, publicId: string) {
  const providerStatus = getOpenAIProviderStatus();

  if (!providerStatus.configured) {
    return "provider_missing" as const;
  }

  const database = await getDatabase();

  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      study_id: string;
      plan_status: string;
      run_id: string | null;
      run_status: string | null;
      run_created_at: string | null;
      run_started_at: string | null;
      run_last_event_at: string | null;
    }>(
      `select
         studies.id::text as study_id,
         study_plans.status as plan_status,
         latest_run.id as run_id,
         latest_run.status as run_status,
         latest_run.created_at::text as run_created_at,
         latest_run.started_at::text as run_started_at,
         latest_run.last_event_at::text as run_last_event_at
       from studies
       join study_plans on study_plans.study_id = studies.id
       left join lateral (
         select study_runs.id::text as id, study_runs.status, study_runs.created_at, study_runs.started_at,
                (select max(study_events.created_at) from study_events where study_events.run_id = study_runs.id) as last_event_at
         from study_runs
         where study_runs.study_id = studies.id
         order by study_runs.created_at desc, study_runs.id desc
         limit 1
       ) latest_run on true
       where studies.public_id = $1 and studies.workspace_id = $2
       for update of studies`,
      [publicId, viewer.workspaceId],
    );
    const study = result.rows[0];

    if (!study) {
      return "not_found" as const;
    }

    if (study.plan_status !== "confirmed") {
      return "plan_not_confirmed" as const;
    }

    if (study.run_status === "completed") {
      return "completed" as const;
    }

    const activeSince = study.run_last_event_at ?? study.run_started_at ?? study.run_created_at;
    const activeRunExpired = (study.run_status === "running" || study.run_status === "queued")
      && activeSince !== null
      && Date.now() - new Date(activeSince).getTime() > 10 * 60 * 1000;

    if ((study.run_status === "running" || study.run_status === "queued") && !activeRunExpired) {
      return "already_running" as const;
    }

    if (study.run_id && activeRunExpired) {
      const interruptionMessage = "执行进程超过 10 分钟未更新，已作为中断记录保留。";
      await transaction.query(
        `update study_runs
         set status = 'failed', error_message = $2, finished_at = now()
         where id = $1 and status in ('queued', 'running')`,
        [study.run_id, interruptionMessage],
      );
      await transaction.query(
        `insert into study_events (study_id, run_id, event_type, payload)
         values ($1, $2, 'run.interrupted', $3::jsonb)`,
        [study.study_id, study.run_id, JSON.stringify({ message: interruptionMessage, recoverable: true })],
      );
    }

    let queuedRunId = study.run_id;

    if (study.run_id && study.run_status === "awaiting_provider") {
      await transaction.query(
        "update study_runs set status = 'queued', provider = $2, provider_model = $3 where id = $1",
        [study.run_id, providerStatus.providerName, providerStatus.researchModel],
      );
    } else {
      const runResult = await transaction.query<{ id: string }>(
        `insert into study_runs (study_id, status, provider, provider_model)
         values ($1, 'queued', $2, $3)
         returning id::text as id`,
        [study.study_id, providerStatus.providerName, providerStatus.researchModel],
      );
      queuedRunId = runResult.rows[0].id;
    }

    await transaction.query(
      `update studies set status = 'queued', current_stage = 'execution', updated_at = now() where id = $1`,
      [study.study_id],
    );
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, 'run.queued', $3::jsonb)`,
      [study.study_id, queuedRunId, JSON.stringify({ provider: providerStatus.providerName, model: providerStatus.researchModel })],
    );

    return "queued" as const;
  });
}

export async function listStudies(viewer: Viewer, limit = 8): Promise<StudySummary[]> {
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string;
    title: string;
    status: string;
    current_stage: string;
    study_type: string;
    methods: StudyMethod[] | string;
    updated_at: string;
  }>(
    `select
       studies.public_id,
       studies.title,
       studies.status,
       studies.current_stage,
       studies.study_type,
       coalesce(study_plans.methods, '[]'::jsonb) as methods,
       studies.updated_at::text as updated_at
     from studies
     left join study_plans on study_plans.study_id = studies.id
     where studies.workspace_id = $1
     order by studies.updated_at desc
     limit $2`,
    [viewer.workspaceId, limit],
  );

  return result.rows.map((row) => ({
    publicId: row.public_id,
    title: row.title,
    status: row.status,
    currentStage: row.current_stage,
    studyType: row.study_type,
    methods: typeof row.methods === "string" ? JSON.parse(row.methods) : row.methods,
    updatedAt: row.updated_at,
  }));
}

export async function getStudy(viewer: Viewer, publicId: string): Promise<StudyDetail | null> {
  const database = await getDatabase();
  const result = await database.query<{
    id: string;
    public_id: string;
    title: string;
    brief: string;
    status: string;
    current_stage: string;
    study_type: string;
    estimated_tokens: string;
    methods: StudyMethod[] | string;
    framework: string;
    persona_filters: StudyDetail["plan"]["personaFilters"] | string;
    persona_count: number;
    estimated_duration_minutes: number;
    plan_estimated_tokens: string;
    plan_status: StudyDetail["plan"]["status"];
    plan_source: StudyDetail["plan"]["source"];
    plan_provider_model: string | null;
    plan_rationale: string;
    run_id: string | null;
    run_attempt: number | null;
    run_status: string | null;
    run_provider: string | null;
    run_model: string | null;
    run_error: string | null;
    run_created_at: string | null;
    run_started_at: string | null;
    run_finished_at: string | null;
    run_last_event_at: string | null;
    report_public_id: string | null;
    report_title: string | null;
    report_content: (ResearchReport & { citations?: ResearchCitation[] }) | string | null;
    report_generated_at: string | null;
    report_share_enabled: boolean | null;
    report_share_token: string | null;
    updated_at: string;
  }>(
    `select
       studies.id::text as id,
       studies.public_id,
       studies.title,
       studies.brief,
       studies.status,
       studies.current_stage,
       studies.study_type,
       studies.estimated_tokens::text as estimated_tokens,
       study_plans.methods,
       study_plans.framework,
       study_plans.persona_filters,
       study_plans.persona_count,
       study_plans.estimated_duration_minutes,
       study_plans.estimated_tokens::text as plan_estimated_tokens,
       study_plans.status as plan_status,
       study_plans.source as plan_source,
       study_plans.provider_model as plan_provider_model,
       study_plans.rationale as plan_rationale,
       latest_run.id::text as run_id,
       latest_run.attempt as run_attempt,
       latest_run.status as run_status,
       latest_run.provider as run_provider,
       latest_run.provider_model as run_model,
       latest_run.error_message as run_error,
       latest_run.created_at::text as run_created_at,
       latest_run.started_at::text as run_started_at,
       latest_run.finished_at::text as run_finished_at,
       latest_run.last_event_at::text as run_last_event_at,
       reports.public_id as report_public_id,
       reports.title as report_title,
       reports.content_json as report_content,
       reports.generated_at::text as report_generated_at,
       reports.share_enabled as report_share_enabled,
       reports.share_token as report_share_token,
       studies.updated_at::text as updated_at
     from studies
     join study_plans on study_plans.study_id = studies.id
     left join reports on reports.study_id = studies.id
     left join lateral (
       select study_runs.id, study_runs.status, study_runs.provider, study_runs.provider_model,
              study_runs.error_message, study_runs.created_at, study_runs.started_at, study_runs.finished_at,
              (select max(study_events.created_at) from study_events where study_events.run_id = study_runs.id) as last_event_at,
              count(*) over ()::int as attempt
       from study_runs
       where study_runs.study_id = studies.id
       order by study_runs.created_at desc
       limit 1
     ) latest_run on true
     where studies.public_id = $1 and studies.workspace_id = $2
     limit 1`,
    [publicId, viewer.workspaceId],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  const [messagesResult, eventsResult, personasResult, panelResult, interviewsResult, runsResult, tasksResult, artifactsResult] = await Promise.all([
    database.query<{
    id: string;
    role: StudyDetail["messages"][number]["role"];
    part_type: string;
    content: string | null;
    payload: Record<string, unknown> | string;
    created_at: string;
    }>(
    `select id::text as id, role, part_type, content, payload, created_at::text as created_at
     from study_messages
     where study_id = $1
     order by created_at asc, id asc`,
    [row.id],
    ),
    database.query<{
      id: string;
      run_id: string | null;
      event_type: string;
      payload: Record<string, unknown> | string;
      created_at: string;
    }>(
      `select id::text as id, run_id::text as run_id, event_type, payload, created_at::text as created_at
       from study_events
       where study_id = $1
       order by created_at asc, id asc`,
      [row.id],
    ),
    database.query<{
      public_id: string;
      name: string;
      archetype: string;
      profile: SyntheticPanelResearch["personas"][number] | string;
    }>(
      `select persona.public_id, persona.name, persona.archetype, persona.profile
       from study_personas persona
       where (
         persona.study_id = $1 and ($2::bigint is null or persona.run_id = $2)
       ) or exists (
         select 1
         from study_panel_members member
         join study_panels panel on panel.id = member.panel_id
         where member.persona_id = persona.id
           and panel.study_id = $1
           and ($2::bigint is null or panel.run_id = $2)
       )
       order by persona.created_at asc, persona.id asc`,
      [row.id, row.run_id],
    ),
    database.query<{
      public_id: string;
      title: string;
      description: string;
    }>(
      `select public_id, title, description
       from study_panels
       where study_id = $1 and ($2::bigint is null or run_id = $2)
       order by created_at desc, id desc
       limit 1`,
      [row.id, row.run_id],
    ),
    database.query<{
      persona_public_id: string;
      persona_name: string;
      batch: number;
      objective: string;
      content: SyntheticPanelResearch["interviews"][number] | string;
    }>(
      `select p.public_id as persona_public_id, p.name as persona_name,
              i.batch, i.objective, i.content
       from study_interviews i
       join study_personas p on p.id = i.persona_id
       where i.study_id = $1 and ($2::bigint is null or i.run_id = $2)
       order by i.batch asc, i.created_at asc, i.id asc`,
      [row.id, row.run_id],
    ),
    database.query<{
      id: string;
      status: string;
      provider: string | null;
      provider_model: string | null;
      error_message: string | null;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
      event_count: number;
      completed_steps: number;
      total_steps: number;
    }>(
      `select r.id::text as id, r.status, r.provider, r.provider_model, r.error_message,
              r.created_at::text as created_at, r.started_at::text as started_at,
              r.finished_at::text as finished_at,
              count(e.id)::int as event_count,
              case when task_counts.total_steps > 0
                then task_counts.completed_steps
                else count(distinct e.event_type) filter (where e.event_type in (
                  'trend.scan.completed', 'upgrade.scan.completed', 'policy.research.completed',
                  'personas.generated', 'panel.created', 'interviews.batch1.completed',
                  'interviews.batch2.completed', 'validation.completed', 'report.generated'
                ))::int
              end as completed_steps,
              case when task_counts.total_steps > 0 then task_counts.total_steps else 9 end as total_steps
       from study_runs r
       left join study_events e on e.run_id = r.id
       left join lateral (
         select count(*)::int as total_steps,
                count(*) filter (where task.status in ('completed', 'skipped'))::int as completed_steps
         from study_tasks task
         where task.run_id = r.id
       ) task_counts on true
       where r.study_id = $1
       group by r.id, task_counts.total_steps, task_counts.completed_steps
       order by r.created_at asc, r.id asc`,
      [row.id],
    ),
    database.query<{
      public_id: string;
      run_id: string;
      task_key: string;
      title: string;
      tool_name: string;
      status: StudyDetail["tasks"][number]["status"];
      position: number;
      depends_on: string[] | string;
      input: Record<string, unknown> | string;
      output: Record<string, unknown> | string;
      error_message: string | null;
      attempt: number;
      started_at: string | null;
      finished_at: string | null;
    }>(
      `select public_id, run_id::text as run_id, task_key, title, tool_name, status,
              position, depends_on, input, output, error_message, attempt,
              started_at::text as started_at, finished_at::text as finished_at
       from study_tasks
       where study_id = $1 and ($2::bigint is null or run_id = $2)
       order by position, id`,
      [row.id, row.run_id],
    ),
    database.query<{
      public_id: string;
      run_id: string;
      task_key: string | null;
      artifact_type: string;
      title: string;
      content: Record<string, unknown> | string;
      created_at: string;
      updated_at: string;
    }>(
      `select artifact.public_id, artifact.run_id::text as run_id,
              task.task_key, artifact.artifact_type, artifact.title, artifact.content,
              artifact.created_at::text as created_at, artifact.updated_at::text as updated_at
       from study_artifacts artifact
       left join study_tasks task on task.id = artifact.task_id
       where artifact.study_id = $1 and ($2::bigint is null or artifact.run_id = $2)
       order by artifact.created_at asc, artifact.id asc`,
      [row.id, row.run_id],
    ),
  ]);

  const methods = typeof row.methods === "string" ? JSON.parse(row.methods) : row.methods;
  const personaFilters =
    typeof row.persona_filters === "string" ? JSON.parse(row.persona_filters) : row.persona_filters;
  const reportContent = typeof row.report_content === "string"
    ? JSON.parse(row.report_content)
    : row.report_content;
  const clarificationRequested = eventsResult.rows.find((event) => event.event_type === "clarification.requested");
  const clarificationCompleted = eventsResult.rows.findLast((event) => event.event_type === "clarification.completed");
  const requestedPayload = clarificationRequested
    ? typeof clarificationRequested.payload === "string" ? JSON.parse(clarificationRequested.payload) : clarificationRequested.payload
    : {};
  const completedPayload = clarificationCompleted
    ? typeof clarificationCompleted.payload === "string" ? JSON.parse(clarificationCompleted.payload) : clarificationCompleted.payload
    : {};
  const runActiveSince = row.run_last_event_at ?? row.run_started_at ?? row.run_created_at;
  const runRecoverable = (row.run_status === "queued" || row.run_status === "running")
    && runActiveSince !== null
    && Date.now() - new Date(runActiveSince).getTime() > 10 * 60 * 1000;

  return {
    publicId: row.public_id,
    title: row.title,
    brief: row.brief,
    status: row.status,
    currentStage: row.current_stage,
    studyType: row.study_type,
    estimatedTokens: Number(row.estimated_tokens),
    methods,
    updatedAt: row.updated_at,
    messages: messagesResult.rows.map((message) => ({
      id: message.id,
      role: message.role,
      partType: message.part_type,
      content: message.content ?? "",
      payload: typeof message.payload === "string" ? JSON.parse(message.payload) : message.payload,
      createdAt: message.created_at,
    })),
    plan: {
      framework: row.framework,
      methods,
      personaFilters,
      personaCount: row.persona_count,
      estimatedDurationMinutes: row.estimated_duration_minutes,
      estimatedTokens: Number(row.plan_estimated_tokens),
      status: row.plan_status,
      source: row.plan_source,
      providerModel: row.plan_provider_model,
      rationale: row.plan_rationale,
    },
    runStatus: row.run_status,
    runProvider: row.run_provider,
    runModel: row.run_model,
    runError: row.run_error,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    runCreatedAt: row.run_created_at,
    runStartedAt: row.run_started_at,
    runFinishedAt: row.run_finished_at,
    runRecoverable,
    runHistory: runsResult.rows.map((run, index) => ({
      id: run.id,
      attempt: index + 1,
      status: run.status,
      provider: run.provider,
      model: run.provider_model,
      error: run.error_message,
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      eventCount: run.event_count,
      completedSteps: run.completed_steps,
      totalSteps: run.total_steps,
    })),
    tasks: tasksResult.rows.map((task) => ({
      publicId: task.public_id,
      runId: task.run_id,
      key: task.task_key,
      title: task.title,
      toolName: task.tool_name,
      status: task.status,
      position: task.position,
      dependsOn: typeof task.depends_on === "string" ? JSON.parse(task.depends_on) : task.depends_on,
      input: typeof task.input === "string" ? JSON.parse(task.input) : task.input,
      output: typeof task.output === "string" ? JSON.parse(task.output) : task.output,
      error: task.error_message,
      attempt: task.attempt,
      startedAt: task.started_at,
      finishedAt: task.finished_at,
    })),
    artifacts: artifactsResult.rows.map((artifact) => ({
      publicId: artifact.public_id,
      runId: artifact.run_id,
      taskKey: artifact.task_key,
      type: artifact.artifact_type,
      title: artifact.title,
      content: typeof artifact.content === "string" ? JSON.parse(artifact.content) : artifact.content,
      createdAt: artifact.created_at,
      updatedAt: artifact.updated_at,
    })),
    clarification: clarificationRequested
      ? {
          status: clarificationCompleted ? "completed" : "pending",
          questions: Array.isArray(requestedPayload.questions) ? requestedPayload.questions : [],
          answers: Array.isArray(completedPayload.answers) ? completedPayload.answers : [],
        }
      : { status: "not_required", questions: [], answers: [] },
    events: eventsResult.rows.map((event) => ({
      id: event.id,
      runId: event.run_id,
      type: event.event_type,
      payload: typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload,
      createdAt: event.created_at,
    })),
    personas: personasResult.rows.map((persona) => ({
      publicId: persona.public_id,
      name: persona.name,
      archetype: persona.archetype,
      profile: typeof persona.profile === "string" ? JSON.parse(persona.profile) : persona.profile,
    })),
    panel: panelResult.rows[0]
      ? {
          publicId: panelResult.rows[0].public_id,
          title: panelResult.rows[0].title,
          description: panelResult.rows[0].description,
        }
      : null,
    interviews: interviewsResult.rows.map((interview) => ({
      personaPublicId: interview.persona_public_id,
      personaName: interview.persona_name,
      batch: interview.batch,
      objective: interview.objective,
      content: typeof interview.content === "string" ? JSON.parse(interview.content) : interview.content,
    })),
    report: row.report_public_id && row.report_title && reportContent && row.report_generated_at
      ? {
          publicId: row.report_public_id,
          title: row.report_title,
          content: reportContent,
          citations: reportContent.citations ?? [],
          generatedAt: row.report_generated_at,
          shareEnabled: row.report_share_enabled ?? false,
          shareToken: row.report_share_token,
        }
      : null,
  };
}
