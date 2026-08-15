import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { Viewer } from "@/lib/auth";
import { createConfirmedPlanVersion } from "@/lib/study-plan-versions";
import type { StudyMethod, StudyProductLine } from "@/lib/research-types";
import { retrieveContext, retrieveContextWithQueryable } from "@/lib/context-system";
import {
  compileWorkflowDefinition,
  createConfirmedIntentVersion,
  createDraftIntentVersion,
  formatIntentPlanningContext,
} from "@/lib/intent-workflow-contracts";
import { createMarketInsightTaskPlan, createResearchTaskPlan, listResearchSkills } from "@/lib/research-harness";
import { getRuntimeLimits } from "@/lib/runtime-control";
import { submitTaskInput } from "@/lib/task-recovery";
import { getReportEvidenceGraph, materializeReportEvidenceGraph, sanitizeReportEvidenceGraphForPublic, type ReportEvidenceGraph } from "@/lib/evidence-graph";
import {
  effectiveRetentionStatus,
  groundStudyPersonasFromEvidence,
  normalizeGroundingSummary,
  type PersonaEvidenceConfidence,
  type PersonaEvidenceStatus,
  type PersonaGroundingSummary,
  type PersonaRetentionStatus,
} from "@/lib/persona-evidence";
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

export type { StudyMethod } from "@/lib/research-types";

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
  productLine: StudyProductLine;
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
    version: number;
    versionPublicId: string | null;
    schemaVersion: string | null;
    contentHash: string | null;
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
    promptVersion: string;
    rationale: string;
  };
  intent: {
    version: number;
    publicId: string;
    schemaVersion: string;
    lifecycleStatus: "draft" | "confirmed";
    productLine: StudyProductLine;
    contentHash: string;
    objective: string;
    audience: Record<string, unknown>;
    budget: Record<string, unknown>;
    dataScope: Record<string, unknown>;
    compliance: Record<string, unknown>;
    requestedMethods: StudyMethod[];
    assumptions: string[];
    openQuestions: string[];
    promptVersion: string;
    providerModel: string | null;
    context: {
      retrievalPublicId: string;
      purpose: string;
      policyVersion: string;
      policyDecision: Record<string, unknown>;
      citationCount: number;
    } | null;
  } | null;
  workflow: {
    publicId: string;
    version: number;
    schemaVersion: string;
    workflowType: string;
    templateVersion: string;
    compilerVersion: string;
    contentHash: string;
    taskCount: number;
    skillRequirements: Array<{ slug: string; version: number }>;
    runtimeLimits: Record<string, unknown>;
  } | null;
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
    publicId: string;
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
    maxAttempts: number;
    nextAttemptAt: string | null;
    lastErrorCode: string | null;
    lastErrorClass: string | null;
    retryable: boolean | null;
    waitingReason: string | null;
    waitingPayload: Record<string, unknown> | null;
    resumedAt: string | null;
    resumeCount: number;
    startedAt: string | null;
    finishedAt: string | null;
    origin: "planned" | "dynamic";
    generation: number;
    reasoningDecisionPublicId: string | null;
    attempts: Array<{
      publicId: string;
      attempt: number;
      status: "running" | "completed" | "failed" | "interrupted" | "waiting_input" | "cancelled";
      errorClass: string | null;
      errorCode: string | null;
      error: string | null;
      retryable: boolean | null;
      startedAt: string;
      finishedAt: string | null;
    }>;
    inputRequest: {
      publicId: string;
      request: Record<string, unknown>;
      requestedAt: string;
    } | null;
  }>;
  reasoningDecisions: Array<{
    publicId: string;
    runId: string;
    sequence: number;
    triggerType: string;
    policyVersion: string;
    metrics: Record<string, unknown>;
    budget: Record<string, unknown>;
    chosenAction: Record<string, unknown>;
    reason: string;
    createdAt: string;
    candidates: Array<{
      actionType: string;
      score: number;
      allowed: boolean;
      selected: boolean;
      payload: Record<string, unknown>;
      rejectionReasons: string[];
    }>;
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
    evidenceGraph: ReportEvidenceGraph | null;
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
  evidenceStatus: PersonaEvidenceStatus;
  evidenceConfidence: PersonaEvidenceConfidence;
  groundingSummary: PersonaGroundingSummary;
  groundedAt: string | null;
  retentionStatus: PersonaRetentionStatus;
  validUntil: string | null;
  retentionNote: string | null;
  retentionReviewedAt: string | null;
  retentionReviewerName: string | null;
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

function createClarificationQuestions(brief: string, productLine: StudyProductLine): ClarificationQuestion[] {
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
      options: productLine === "market_insight"
        ? ["市场格局与增长驱动", "竞争定位与替代方案", "新兴需求与弱信号", "进入机会与风险"]
        : mobilityStudy
        ? ["换购决策的完整路径", "续航预期与真实体验差距", "充电与换电场景限制", "品牌、价格与功能选择标准"]
        : ["完整决策路径", "核心痛点与未满足需求", "不同方案的比较标准", "使用体验与改进机会"],
      maxSelect: 2,
    },
    {
      id: "target_audience",
      label: productLine === "market_insight" ? "市场范围" : "目标人群",
      question: productLine === "market_insight" ? "本次洞察应优先覆盖哪个市场范围？" : "本次研究应优先覆盖哪类人群？",
      options: productLine === "market_insight"
        ? ["当前核心市场", "相邻品类与替代方案", "新进入者与前沿市场", "覆盖多个地区或细分市场"]
        : mobilityStudy
        ? ["一线城市上班族", "新一线与二线城市通勤者", "长距离高频骑行者", "近期正在换购的人群"]
        : ["现有用户", "近期购买或换购者", "潜在用户", "覆盖多个差异化细分群体"],
      maxSelect: 1,
    },
    {
      id: "research_scope",
      label: "证据范围",
      question: productLine === "market_insight" ? "您希望这次洞察优先使用哪些证据？" : "您希望这次研究如何组合公开资料和 AI 合成 Persona？",
      options: productLine === "market_insight" ? [
        "公开市场、行业与竞品资料",
        "公开资料 + 社交趋势信号",
        "公开资料优先，并输出真人研究验证建议",
        "侧重政策、渠道与市场进入资料",
      ] : [
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

function normalizeProductLinePlan<T extends ReturnType<typeof derivePlan>>(
  productLine: StudyProductLine,
  plan: T,
): T {
  if (productLine === "research") return plan;
  const usesScout = plan.methods.includes("Scout Agent");
  return {
    ...plan,
    studyType: "product_rnd",
    framework: "Market Landscape + Opportunity Mapping",
    methods: usesScout ? ["Scout Agent", "Fast Insight"] : ["Fast Insight"],
    personaFilters: {
      audience: "由 Brief 与后续澄清确定的市场、品类与竞争范围",
      source: usesScout ? "公开市场资料 + 社交趋势信号" : "公开市场、行业与竞品资料",
    },
    personaCount: 1,
    estimatedDurationMinutes: usesScout ? 1440 : 240,
    estimatedTokens: usesScout ? 90000 : 55000,
    rationale: "以可核查公开证据建立市场格局、竞争信号与机会地图；默认不构建 Persona、不执行合成访谈，并把推断与事实证据分开标记。",
  } as T;
}

export async function createStudy(
  viewer: Viewer,
  briefInput: string,
  productLine: StudyProductLine = "research",
  sourcePanelPublicId?: string,
) {
  const database = await getDatabase();
  const brief = briefInput.trim();
  const initialPlan = normalizeProductLinePlan(productLine, derivePlan(brief));
  const questions = createClarificationQuestions(brief, productLine);
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
         public_id, workspace_id, created_by, title, brief, product_line, study_type, status,
         current_stage, estimated_tokens, source_panel_id
       ) values ($1, $2, $3, $4, $5, $6, $7, 'planning', 'clarification', $8, $9)
       returning id::text as id`,
      [
        publicId,
        viewer.workspaceId,
        viewer.userId,
        title,
        brief,
        productLine,
        initialPlan.studyType,
        initialPlan.estimatedTokens,
        sourcePanelId,
      ],
    );
    const studyId = studyResult.rows[0].id;
    const context = await retrieveContextWithQueryable(transaction, {
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: brief,
      assetTypes: ["core_memory", "team_memory", "research_sample", "persona", "study_context"],
      scopes: ["user", "workspace", "study"],
      studyId,
      purpose: "intent_planning",
      limit: 8,
    });
    const planningContext = formatIntentPlanningContext(context);
    const plan = normalizeProductLinePlan(productLine, {
      ...derivePlan([brief, planningContext].filter(Boolean).join("\n\n")),
      source: "local_rules" as const,
      responseId: null,
      model: null,
      promptVersion: "intent-planning-draft-v1",
    });
    await transaction.query(
      "update studies set study_type = $2, estimated_tokens = $3 where id = $1",
      [studyId, plan.studyType, plan.estimatedTokens],
    );

    await transaction.query(
      `insert into study_plans (
         study_id, framework, methods, persona_filters, persona_count,
         estimated_duration_minutes, estimated_tokens, source,
         provider_response_id, provider_model, prompt_version, rationale
       ) values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
        plan.promptVersion,
        plan.rationale,
      ],
    );

    const intentVersion = await createDraftIntentVersion(transaction, {
      workspaceId: viewer.workspaceId,
      studyId,
      brief,
      productLine,
      plan,
      questions,
      answers: [],
      context,
      snapshotReason: "brief_creation",
    });

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
          productLine,
          frameworkCandidate: plan.framework,
          audienceCandidate: plan.personaFilters.audience,
          requiresClarification: true,
          intentVersionPublicId: intentVersion.publicId,
          intentVersion: intentVersion.version,
          intentSchemaVersion: intentVersion.schemaVersion,
          intentContentHash: intentVersion.contentHash,
          contextRetrievalPublicId: context.retrievalPublicId,
          contextCitationCount: context.citations.length,
          contextPolicyDecision: context.policyDecision,
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
      product_line: StudyProductLine;
      status: string;
      current_stage: string;
      study_type: string;
      methods: StudyMethod[] | string;
      updated_at: string;
    }>(
      `select studies.public_id, studies.title, studies.product_line, studies.status, studies.current_stage,
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
      productLine: project.product_line,
      status: project.status,
      currentStage: project.current_stage,
      studyType: project.study_type,
      methods: typeof project.methods === "string" ? JSON.parse(project.methods) : project.methods,
      updatedAt: project.updated_at,
    })),
  };
}

export async function listPersonas(viewer: Viewer, options: { includeInactive?: boolean } = {}): Promise<{
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
      evidence_status: PersonaEvidenceStatus;
      evidence_confidence: PersonaEvidenceConfidence;
      grounding_summary: PersonaGroundingSummary | string;
      grounded_at: string | null;
      retention_status: Exclude<PersonaRetentionStatus, "expired">;
      valid_until: string | null;
      retention_note: string | null;
      retention_reviewed_at: string | null;
      retention_reviewer_name: string | null;
    }>(
      `select persona.public_id, persona.name, persona.archetype, persona.profile,
              persona.source, persona.visibility, persona.created_at::text as created_at,
              persona.updated_at::text as updated_at, persona.created_by::text as created_by,
              studies.public_id as study_public_id, studies.title as study_title,
              persona.evidence_status, persona.evidence_confidence, persona.grounding_summary,
              persona.grounded_at::text as grounded_at, persona.retention_status,
              persona.valid_until::text as valid_until, persona.retention_note,
              persona.retention_reviewed_at::text as retention_reviewed_at,
              retention_reviewer.display_name as retention_reviewer_name,
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
       left join users retention_reviewer on retention_reviewer.id = persona.retention_reviewed_by
       where persona.workspace_id = $1
         and (persona.visibility = 'workspace' or persona.created_by = $2)
         and ($3::boolean or (
           persona.retention_status = 'retained'
           and (persona.valid_until is null or persona.valid_until > now())
         ))
       group by persona.id, studies.public_id, studies.title, retention_reviewer.id
       order by persona.updated_at desc, persona.id desc`,
      [viewer.workspaceId, viewer.userId, options.includeInactive === true],
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
      evidenceStatus: persona.evidence_status,
      evidenceConfidence: persona.evidence_confidence,
      groundingSummary: normalizeGroundingSummary(persona.grounding_summary),
      groundedAt: persona.grounded_at,
      retentionStatus: effectiveRetentionStatus(persona.retention_status, persona.valid_until),
      validUntil: persona.valid_until,
      retentionNote: persona.retention_note,
      retentionReviewedAt: persona.retention_reviewed_at,
      retentionReviewerName: persona.retention_reviewer_name,
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
    await transaction.query(
      `insert into persona_governance_events (
         public_id, workspace_id, persona_id, actor_user_id, event_type, payload
       ) values ($1, $2, $3, $4, 'retention.retained', $5::jsonb)`,
      [
        createPublicId("pge"), viewer.workspaceId, personaResult.rows[0].id, viewer.userId,
        JSON.stringify({ source: "manual_create", retentionStatus: "retained" }),
      ],
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
              visibility = $5, evidence_status = 'ungrounded', evidence_confidence = 'low',
              grounding_summary = '{}'::jsonb, grounded_at = null, updated_at = now() where id = $1`,
      [persona.id, profile.name, profile.archetype, JSON.stringify(profile), input.visibility],
    );
    await transaction.query("delete from persona_evidence_links where persona_id = $1", [persona.id]);
    await transaction.query(
      `insert into persona_governance_events (
         public_id, workspace_id, persona_id, actor_user_id, event_type, payload
       ) values ($1, $2, $3, $4, 'evidence.invalidated', $5::jsonb)`,
      [
        createPublicId("pge"), viewer.workspaceId, persona.id, viewer.userId,
        JSON.stringify({ reason: "profile_edited" }),
      ],
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
    product_line: StudyProductLine;
    plan_status: string;
    completed: boolean;
    questions_payload: { questions?: ClarificationQuestion[] } | string | null;
  }>(
    `select studies.id::text as id, studies.brief, studies.product_line, study_plans.status as plan_status,
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
  const enrichedBrief = `${study.brief}\n${clarificationContext}`;
  const context = await retrieveContext({
    workspaceId: viewer.workspaceId,
    userId: viewer.userId,
    query: enrichedBrief,
    assetTypes: ["core_memory", "team_memory", "research_sample", "persona", "study_context"],
    scopes: ["user", "workspace", "study"],
    studyId: study.id,
    purpose: "intent_planning",
    limit: 8,
  });
  const planningContext = formatIntentPlanningContext(context);
  const governedPlanningInput = [clarificationContext, planningContext
    ? `已批准且允许用于 intent_planning 的 Context：\n${planningContext}`
    : ""].filter(Boolean).join("\n\n");
  const providerStatus = getOpenAIProviderStatus();
  let providerFailure: ReturnType<typeof describeOpenAIError> | null = null;
  let providerPlan: Awaited<ReturnType<typeof generateProviderStudyPlan>> | null = null;

  if (providerStatus.configured) {
    try {
      providerPlan = await generateProviderStudyPlan(study.brief, viewer.userPublicId, governedPlanningInput);
    } catch (error) {
      providerFailure = describeOpenAIError(error);
    }
  }

  const plan = normalizeProductLinePlan(study.product_line, providerPlan ?? {
      ...derivePlan([enrichedBrief, planningContext].filter(Boolean).join("\n\n")),
      source: "local_rules" as const,
      responseId: null,
      model: null,
      promptVersion: "clarified-local-plan-v1",
    });

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
         prompt_version = $11, rationale = $12, updated_at = now()
       where study_id = $1`,
      [
        study.id, plan.framework, JSON.stringify(plan.methods),
        JSON.stringify(plan.personaFilters), plan.personaCount,
        plan.estimatedDurationMinutes, plan.estimatedTokens, plan.source,
        plan.responseId, plan.model, plan.promptVersion, plan.rationale,
      ],
    );
    const intentVersion = await createDraftIntentVersion(transaction, {
      workspaceId: viewer.workspaceId,
      studyId: study.id,
      brief: study.brief,
      productLine: study.product_line,
      plan,
      questions,
      answers,
      context,
      snapshotReason: "clarification",
    });
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
          intentVersionPublicId: intentVersion.publicId,
          intentVersion: intentVersion.version,
          intentContentHash: intentVersion.contentHash,
          contextRetrievalPublicId: context.retrievalPublicId,
          contextCitationCount: context.citations.length,
          contextPolicyDecision: context.policyDecision,
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
    payload: Record<string, unknown> | string;
  }>(
    `select role, content, payload from study_messages
     where study_id = $1 and part_type in ('followup_question', 'followup_answer')
     order by created_at asc, id asc`,
    [study.study_id],
  );

  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [];
  let pendingQuestion: string | null = null;
  for (const message of conversationResult.rows) {
    if (message.role === "user") {
      pendingQuestion = message.content ?? "";
      continue;
    }
    const payload = typeof message.payload === "string" ? JSON.parse(message.payload) : message.payload;
    if (pendingQuestion && payload.model !== "local-report-fallback") {
      conversation.push(
        { role: "user", content: pendingQuestion },
        { role: "assistant", content: message.content ?? "" },
      );
    }
    pendingQuestion = null;
  }

  let answer: Awaited<ReturnType<typeof generateProviderFollowupAnswer>>;
  try {
    answer = await generateProviderFollowupAnswer({
      question,
      report: reportContent,
      citations,
      conversation,
      userPublicId: viewer.userPublicId,
      studyPublicId: publicId,
    });
  } catch (error) {
    return { status: "provider_failed" as const, error: describeOpenAIError(error) };
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
        presentation: {
          title: answer.title,
          summary: answer.summary,
          sections: answer.sections,
          conclusion: answer.conclusion,
        },
        caveat: answer.caveat,
        citations: citationDetails,
        responseId: answer.responseId,
        model: answer.model,
        promptVersion: answer.promptVersion,
      })],
    );
    await transaction.query(
      `insert into study_events (study_id, event_type, payload)
       values ($1, 'followup.answered', $2::jsonb)`,
      [study.study_id, JSON.stringify({ citationCount: citationDetails.length, model: answer.model })],
    );
    await transaction.query("update studies set updated_at = now() where id = $1", [study.study_id]);
  });

  return { status: "completed" as const };
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
    report_id: string;
    report_title: string;
    report_content: (ResearchReport & { citations?: ResearchCitation[] }) | string;
    report_generated_at: string;
  }>(
    `select studies.id::text as study_id, studies.title, studies.brief,
       reports.id::text as report_id, reports.public_id as report_public_id, reports.title as report_title,
       reports.content_json as report_content, reports.generated_at::text as report_generated_at
     from reports
     join studies on studies.id = reports.study_id
     where reports.share_enabled = true and reports.share_token = $1 and studies.status = 'completed'
     limit 1`,
    [shareToken],
  );
  const row = result.rows[0];
  if (!row) return null;

  const [personasResult, panelResult, interviewsResult, evidenceGraph] = await Promise.all([
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
    getReportEvidenceGraph(database, row.report_id),
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
      evidenceGraph: sanitizeReportEvidenceGraphForPublic(evidenceGraph),
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
    const result = await transaction.query<{
      id: string;
      workspace_id: string;
      brief: string;
      product_line: StudyProductLine;
      study_type: string;
      plan_status: string;
      methods: StudyMethod[] | string;
      persona_count: number;
    }>(
      `select studies.id::text as id, studies.workspace_id::text as workspace_id,
              studies.brief, studies.product_line, studies.study_type, study_plans.status as plan_status,
              study_plans.methods, study_plans.persona_count
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

    const intentVersion = await createConfirmedIntentVersion(transaction, study.id, viewer.userId);
    const planVersion = await createConfirmedPlanVersion(transaction, study.id, viewer.userId, intentVersion.id);
    const methods = typeof study.methods === "string" ? JSON.parse(study.methods) as StudyMethod[] : study.methods;
    const taskGraph = study.product_line === "market_insight"
      ? createMarketInsightTaskPlan({ methods, brief: study.brief })
      : createResearchTaskPlan({
          studyType: study.study_type,
          methods,
          brief: study.brief,
          personaCount: study.persona_count,
        });
    const workflowContract = study.product_line === "market_insight" ? {
      workflowType: "market_insight" as const,
      templateKey: "market_insight_dag",
      templateVersion: "market-insight-dag-v1",
      outputContracts: ["market_landscape", "opportunity_map", "competitive_signals", "evidence", "report"],
    } : {
      workflowType: "batch_research" as const,
      templateKey: "research_dag",
      templateVersion: "research-dag-v3-dynamic",
      outputContracts: ["research_plan", "evidence", "personas", "panel", "interviews", "report"],
    };
    const skillVersions = new Map(listResearchSkills().map((skill) => [skill.slug, skill.version]));
    const skillRequirements = [...new Set(taskGraph.map((task) => task.toolName))].map((slug) => ({
      slug,
      version: skillVersions.get(slug) ?? 1,
    }));
    const limits = getRuntimeLimits();
    const workflow = await compileWorkflowDefinition(transaction, {
      workspaceId: study.workspace_id,
      studyId: study.id,
      intentVersionId: intentVersion.id,
      planVersionId: planVersion.id,
      taskGraph,
      skillRequirements,
      runtimeLimits: {
        runTimeoutSeconds: limits.runTimeoutSeconds,
        taskTimeoutSeconds: limits.taskTimeoutSeconds,
      },
      ...workflowContract,
      compiledBy: viewer.userId,
    });
    await transaction.query(
      `update studies
       set status = 'queued', current_stage = 'execution', updated_at = now()
       where id = $1`,
      [study.id],
    );
    const runResult = await transaction.query<{ id: string }>(
      `insert into study_runs (
         study_id, plan_version_id, intent_version_id, workflow_definition_id,
         workflow_type, workflow_version, timeout_seconds, status
       ) values ($1, $2, $3, $4, $5, $6, $7, 'awaiting_provider')
       returning id::text as id`,
      [
        study.id, planVersion.id, intentVersion.id, workflow.id,
        workflow.workflowType, workflow.templateVersion, limits.runTimeoutSeconds,
      ],
    );
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, 'plan.confirmed', $3::jsonb)`,
      [study.id, runResult.rows[0].id, JSON.stringify({
        planVersionPublicId: planVersion.publicId,
        version: planVersion.version,
        schemaVersion: planVersion.schemaVersion,
        contentHash: planVersion.contentHash,
        intentVersionPublicId: intentVersion.publicId,
        intentVersion: intentVersion.version,
        intentSchemaVersion: intentVersion.schemaVersion,
        intentContentHash: intentVersion.contentHash,
        contextRetrievalId: intentVersion.contextRetrievalId,
        workflowDefinitionPublicId: workflow.publicId,
        workflowDefinitionVersion: workflow.version,
        productLine: study.product_line,
        workflowType: workflow.workflowType,
        workflowSchemaVersion: workflow.schemaVersion,
        workflowContentHash: workflow.contentHash,
      })],
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
       locked_plan.framework,
       locked_plan.methods,
       locked_plan.persona_filters,
       users.public_id as user_public_id,
       studies.created_by::text as created_by,
       latest_run.id as run_id,
       latest_run.status as run_status
     from studies
     join users on users.id = studies.created_by
     left join lateral (
       select study_runs.id::text as id, study_runs.status, study_runs.plan_version_id
       from study_runs
       where study_runs.study_id = studies.id
       order by study_runs.created_at desc, study_runs.id desc
       limit 1
     ) latest_run on true
     left join study_plan_versions locked_plan on locked_plan.id = latest_run.plan_version_id
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
      const personaGroundingCandidates: Array<{ publicId: string; name: string }> = [];

      for (const persona of providerResult.panelResearch.personas) {
        const personaResult = await transaction.query<{ id: string; public_id: string }>(
          `insert into study_personas (
             public_id, workspace_id, created_by, study_id, run_id, name, archetype, profile, retention_status
           ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending')
           returning id::text as id, public_id`,
          [
            createPublicId("per"), workspaceId, study.created_by, study.study_id, study.run_id,
            persona.name, persona.archetype, JSON.stringify(persona),
          ],
        );
        personaIdsByName.set(persona.name, personaResult.rows[0].id);
        personaGroundingCandidates.push({ publicId: personaResult.rows[0].public_id, name: persona.name });
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

      const storedReport = await transaction.query<{ id: string }>(
        `insert into reports (public_id, study_id, title, description, content_html, content_json)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (study_id) do update set
           title = excluded.title,
           description = excluded.description,
           content_html = excluded.content_html,
           content_json = excluded.content_json,
           generated_at = now()
         returning id::text as id`,
        [
          reportPublicId,
          study.study_id,
          providerResult.report.title,
          providerResult.report.executiveSummary,
          renderReportHtml(providerResult.report),
          JSON.stringify(contentJson),
        ],
      );
      await materializeReportEvidenceGraph(transaction, {
        workspaceId,
        studyId: study.study_id,
        runId: study.run_id,
        reportId: storedReport.rows[0].id,
        report: providerResult.report,
        citations: providerResult.citations,
        catalog: providerResult.evidenceCatalog,
        provider: providerStatus.providerName,
        providerModel: providerResult.model,
        providerResponseId: providerResult.responseId,
        promptVersion: providerResult.promptVersion,
      });
      await groundStudyPersonasFromEvidence(transaction, {
        workspaceId,
        studyId: study.study_id,
        runId: study.run_id,
        personas: personaGroundingCandidates,
      });
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
      current_plan_version_id: string | null;
      current_intent_version_id: string | null;
      workflow_definition_id: string | null;
      workflow_type: string | null;
      workflow_version: string | null;
      run_timeout_seconds: number | null;
      run_id: string | null;
      run_status: string | null;
      run_created_at: string | null;
      run_started_at: string | null;
      run_last_event_at: string | null;
    }>(
      `select
         studies.id::text as study_id,
         study_plans.status as plan_status,
         study_plans.current_plan_version_id::text as current_plan_version_id,
         current_plan.intent_version_id::text as current_intent_version_id,
         workflow.id::text as workflow_definition_id,
         workflow.workflow_type,
         workflow.template_version as workflow_version,
         (workflow.runtime_limits ->> 'runTimeoutSeconds')::int as run_timeout_seconds,
         latest_run.id as run_id,
         latest_run.status as run_status,
         latest_run.created_at::text as run_created_at,
         latest_run.started_at::text as run_started_at,
         latest_run.last_event_at::text as run_last_event_at
       from studies
       join study_plans on study_plans.study_id = studies.id
       left join study_plan_versions current_plan on current_plan.id = study_plans.current_plan_version_id
       left join lateral (
         select definition.id, definition.workflow_type, definition.template_version, definition.runtime_limits
         from workflow_definitions definition
         where definition.study_id = studies.id
           and definition.plan_version_id = current_plan.id
           and definition.intent_version_id = current_plan.intent_version_id
         order by definition.version desc limit 1
       ) workflow on true
       left join lateral (
         select study_runs.id::text as id, study_runs.status, study_runs.created_at, study_runs.started_at,
                greatest(
                  (select max(study_events.created_at) from study_events where study_events.run_id = study_runs.id),
                  (select job.updated_at from study_job_queue job where job.run_id = study_runs.id)
                ) as last_event_at
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

    if (!study.current_plan_version_id) {
      throw new Error("CONFIRMED_PLAN_VERSION_MISSING");
    }

    if (study.run_status === "completed") {
      return "completed" as const;
    }

    if (study.run_status === "waiting_input") {
      return "waiting_input" as const;
    }

    const activeSince = study.run_last_event_at ?? study.run_started_at ?? study.run_created_at;
    const activeRunExpired = (study.run_status === "running" || study.run_status === "queued")
      && activeSince !== null
      && Date.now() - new Date(activeSince).getTime() > 10 * 60 * 1000;

    if ((study.run_status === "running" || study.run_status === "queued") && !activeRunExpired) {
      return "already_running" as const;
    }

    if (study.run_id && activeRunExpired) {
      const liveSlot = await transaction.query<{ id: string }>(
        `select id::text as id from provider_runtime_slots
         where run_id = $1 and lease_expires_at > now() limit 1`,
        [study.run_id],
      );
      if (liveSlot.rows[0]) return "already_running" as const;
      const interruptionMessage = "执行进程超过 10 分钟未更新，已从最近 checkpoint 排队恢复。";
      await transaction.query(
        `update study_runs
         set status = 'queued', error_message = null, finished_at = null
         where id = $1 and status in ('queued', 'running')`,
        [study.run_id],
      );
      await transaction.query(
        "update studies set status = 'queued', current_stage = 'execution', updated_at = now() where id = $1",
        [study.study_id],
      );
      await transaction.query(
        `insert into study_events (study_id, run_id, event_type, payload)
         values ($1, $2, 'run.recovery_queued', $3::jsonb)`,
        [study.study_id, study.run_id, JSON.stringify({ message: interruptionMessage, recoverable: true })],
      );
      return "queued" as const;
    }

    let queuedRunId = study.run_id;

    if (study.run_id && study.run_status === "awaiting_provider") {
      await transaction.query(
        "update study_runs set status = 'queued', provider = $2, provider_model = $3 where id = $1",
        [study.run_id, providerStatus.providerName, providerStatus.researchModel],
      );
    } else {
      const runResult = await transaction.query<{ id: string }>(
        `insert into study_runs (
           study_id, plan_version_id, intent_version_id, workflow_definition_id,
           workflow_type, workflow_version, timeout_seconds, status, provider, provider_model
         ) values ($1, $2, $3, $4, coalesce($5, 'batch_research'),
                   coalesce($6, 'research-dag-v3-dynamic'), coalesce($7, 1800), 'queued', $8, $9)
         returning id::text as id`,
        [
          study.study_id, study.current_plan_version_id, study.current_intent_version_id,
          study.workflow_definition_id, study.workflow_type, study.workflow_version,
          study.run_timeout_seconds, providerStatus.providerName, providerStatus.researchModel,
        ],
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

export async function submitStudyTaskInput(
  viewer: Viewer,
  studyPublicId: string,
  taskPublicId: string,
  response: Record<string, unknown>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction((transaction) => submitTaskInput(transaction, {
    workspaceId: viewer.workspaceId,
    viewerId: viewer.userId,
    studyPublicId,
    taskPublicId,
    response,
  }));
}

export async function listStudies(viewer: Viewer, limit = 8): Promise<StudySummary[]> {
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string;
    title: string;
    product_line: StudyProductLine;
    status: string;
    current_stage: string;
    study_type: string;
    methods: StudyMethod[] | string;
    updated_at: string;
  }>(
    `select
       studies.public_id,
       studies.title,
       studies.product_line,
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
    productLine: row.product_line,
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
    product_line: StudyProductLine;
    status: string;
    current_stage: string;
    study_type: string;
    estimated_tokens: string;
    methods: StudyMethod[] | string;
    plan_version: number;
    plan_version_public_id: string | null;
    plan_schema_version: string | null;
    plan_content_hash: string | null;
    framework: string;
    persona_filters: StudyDetail["plan"]["personaFilters"] | string;
    persona_count: number;
    estimated_duration_minutes: number;
    plan_estimated_tokens: string;
    plan_status: StudyDetail["plan"]["status"];
    plan_source: StudyDetail["plan"]["source"];
    plan_provider_model: string | null;
    plan_prompt_version: string;
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
    report_id: string | null;
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
       studies.product_line,
       studies.status,
       studies.current_stage,
       studies.study_type,
       studies.estimated_tokens::text as estimated_tokens,
       study_plans.methods,
       study_plans.version as plan_version,
       current_plan.public_id as plan_version_public_id,
       current_plan.schema_version as plan_schema_version,
       current_plan.content_hash as plan_content_hash,
       study_plans.framework,
       study_plans.persona_filters,
       study_plans.persona_count,
       study_plans.estimated_duration_minutes,
       study_plans.estimated_tokens::text as plan_estimated_tokens,
       study_plans.status as plan_status,
       study_plans.source as plan_source,
       study_plans.provider_model as plan_provider_model,
       study_plans.prompt_version as plan_prompt_version,
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
       reports.id::text as report_id,
       reports.public_id as report_public_id,
       reports.title as report_title,
       reports.content_json as report_content,
       reports.generated_at::text as report_generated_at,
       reports.share_enabled as report_share_enabled,
       reports.share_token as report_share_token,
       studies.updated_at::text as updated_at
     from studies
     join study_plans on study_plans.study_id = studies.id
     left join study_plan_versions current_plan on current_plan.id = study_plans.current_plan_version_id
     left join reports on reports.study_id = studies.id
     left join lateral (
       select study_runs.id, study_runs.status, study_runs.provider, study_runs.provider_model,
              study_runs.error_message, study_runs.created_at, study_runs.started_at, study_runs.finished_at,
              greatest(
                (select max(study_events.created_at) from study_events where study_events.run_id = study_runs.id),
                (select job.updated_at from study_job_queue job where job.run_id = study_runs.id)
              ) as last_event_at,
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

  const [messagesResult, eventsResult, personasResult, panelResult, interviewsResult, runsResult, tasksResult, attemptsResult, inputsResult, artifactsResult, decisionsResult, evidenceGraph, intentResult, workflowResult] = await Promise.all([
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
      public_id: string;
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
      `select r.id::text as id, r.public_id, r.status, r.provider, r.provider_model, r.error_message,
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
      max_attempts: number;
      next_attempt_at: string | null;
      last_error_code: string | null;
      last_error_class: string | null;
      retryable: boolean | null;
      waiting_reason: string | null;
      waiting_payload: Record<string, unknown> | string | null;
      resumed_at: string | null;
      resume_count: number;
      started_at: string | null;
      finished_at: string | null;
      origin: "planned" | "dynamic";
      generation: number;
      reasoning_decision_public_id: string | null;
    }>(
      `select task.public_id, task.run_id::text as run_id, task.task_key, task.title,
              task.tool_name, task.status, task.position, task.depends_on, task.input,
              task.output, task.error_message, task.attempt, task.max_attempts, task.next_attempt_at::text as next_attempt_at,
              task.last_error_code, task.last_error_class, task.retryable, task.waiting_reason, task.waiting_payload,
              task.resumed_at::text as resumed_at, task.resume_count,
              task.started_at::text as started_at, task.finished_at::text as finished_at,
              task.origin, task.generation, decision.public_id as reasoning_decision_public_id
       from study_tasks task
       left join reasoning_decisions decision on decision.id = task.reasoning_decision_id
       where task.study_id = $1 and ($2::bigint is null or task.run_id = $2)
       order by task.position, task.id`,
    [row.id, row.run_id],
    ),
    database.query<{
      task_public_id: string;
      public_id: string;
      attempt: number;
      status: StudyDetail["tasks"][number]["attempts"][number]["status"];
      error_class: string | null;
      error_code: string | null;
      error_message: string | null;
      retryable: boolean | null;
      started_at: string;
      finished_at: string | null;
    }>(
      `select task.public_id as task_public_id, attempt.public_id, attempt.attempt, attempt.status,
              attempt.error_class, attempt.error_code, attempt.error_message, attempt.retryable,
              attempt.started_at::text as started_at, attempt.finished_at::text as finished_at
       from study_task_attempts attempt
       join study_tasks task on task.id = attempt.task_id
       where attempt.study_id = $1 and ($2::bigint is null or attempt.run_id = $2)
       order by task.position, attempt.attempt`,
      [row.id, row.run_id],
    ),
    database.query<{
      task_public_id: string;
      public_id: string;
      request_payload: Record<string, unknown> | string;
      requested_at: string;
    }>(
      `select task.public_id as task_public_id, request.public_id, request.request_payload,
              request.requested_at::text as requested_at
       from study_task_inputs request
       join study_tasks task on task.id = request.task_id
       where request.study_id = $1 and ($2::bigint is null or request.run_id = $2)
         and request.status = 'pending'
       order by request.requested_at desc`,
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
    database.query<{
      public_id: string;
      run_id: string;
      sequence: number;
      trigger_type: string;
      policy_version: string;
      metrics: Record<string, unknown> | string;
      budget_snapshot: Record<string, unknown> | string;
      chosen_action: Record<string, unknown> | string;
      reason: string;
      created_at: string;
      candidates: unknown[] | string;
    }>(
      `select decision.public_id, decision.run_id::text as run_id, decision.sequence,
              decision.trigger_type, decision.policy_version, decision.metrics,
              decision.budget_snapshot, decision.chosen_action, decision.reason,
              decision.created_at::text as created_at,
              coalesce(jsonb_agg(jsonb_build_object(
                'actionType', candidate.action_type,
                'score', candidate.score,
                'allowed', candidate.allowed,
                'selected', candidate.selected,
                'payload', candidate.payload,
                'rejectionReasons', candidate.rejection_reasons
              ) order by candidate.position) filter (where candidate.id is not null), '[]'::jsonb) as candidates
       from reasoning_decisions decision
       left join reasoning_decision_candidates candidate on candidate.decision_id = decision.id
       where decision.study_id = $1 and ($2::bigint is null or decision.run_id = $2)
       group by decision.id
       order by decision.sequence, decision.id`,
      [row.id, row.run_id],
    ),
    row.report_id ? getReportEvidenceGraph(database, row.report_id) : Promise.resolve(null),
    database.query<{
      public_id: string; version: number; schema_version: string;
      lifecycle_status: "draft" | "confirmed"; product_line: StudyProductLine; content_hash: string; objective: string;
      audience: Record<string, unknown> | string; budget: Record<string, unknown> | string;
      data_scope: Record<string, unknown> | string; compliance: Record<string, unknown> | string;
      requested_methods: StudyMethod[] | string; assumptions: string[] | string;
      open_questions: string[] | string; prompt_version: string; provider_model: string | null;
      retrieval_public_id: string | null; retrieval_purpose: string | null;
      retrieval_policy_version: string | null; retrieval_policy_decision: Record<string, unknown> | string | null;
      citation_count: number;
    }>(
      `select intent.public_id, intent.version, intent.schema_version, intent.lifecycle_status,
              intent.product_line, intent.content_hash, intent.objective, intent.audience, intent.budget,
              intent.data_scope, intent.compliance, intent.requested_methods, intent.assumptions,
              intent.open_questions, intent.prompt_version, intent.provider_model,
              retrieval.public_id as retrieval_public_id, retrieval.purpose as retrieval_purpose,
              retrieval.policy_version as retrieval_policy_version,
              retrieval.policy_decision as retrieval_policy_decision,
              coalesce((select count(*) from context_retrieval_items item where item.retrieval_id = retrieval.id), 0)::int as citation_count
       from studies study
       join study_intent_versions intent on intent.id = study.current_intent_version_id
       left join context_retrievals retrieval on retrieval.id = intent.context_retrieval_id
       where study.id = $1 limit 1`,
      [row.id],
    ),
    database.query<{
      public_id: string; version: number; schema_version: string; workflow_type: string;
      template_version: string; compiler_version: string; content_hash: string;
      task_count: number; skill_requirements: Array<{ slug: string; version: number }> | string;
      runtime_limits: Record<string, unknown> | string;
    }>(
      `select definition.public_id, definition.version, definition.schema_version,
              definition.workflow_type, definition.template_version, definition.compiler_version,
              definition.content_hash, jsonb_array_length(definition.task_graph)::int as task_count,
              definition.skill_requirements, definition.runtime_limits
       from workflow_definitions definition
       where definition.study_id = $1
       order by definition.version desc limit 1`,
      [row.id],
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
  const intent = intentResult.rows[0];
  const workflow = workflowResult.rows[0];
  const attemptsByTask = new Map<string, StudyDetail["tasks"][number]["attempts"]>();
  for (const attempt of attemptsResult.rows) {
    const entries = attemptsByTask.get(attempt.task_public_id) ?? [];
    entries.push({
      publicId: attempt.public_id,
      attempt: attempt.attempt,
      status: attempt.status,
      errorClass: attempt.error_class,
      errorCode: attempt.error_code,
      error: attempt.error_message,
      retryable: attempt.retryable,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
    });
    attemptsByTask.set(attempt.task_public_id, entries);
  }
  const inputByTask = new Map(inputsResult.rows.map((request) => [request.task_public_id, {
    publicId: request.public_id,
    request: typeof request.request_payload === "string" ? JSON.parse(request.request_payload) : request.request_payload,
    requestedAt: request.requested_at,
  }]));

  return {
    publicId: row.public_id,
    title: row.title,
    productLine: row.product_line,
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
      version: row.plan_version,
      versionPublicId: row.plan_version_public_id,
      schemaVersion: row.plan_schema_version,
      contentHash: row.plan_content_hash,
      framework: row.framework,
      methods,
      personaFilters,
      personaCount: row.persona_count,
      estimatedDurationMinutes: row.estimated_duration_minutes,
      estimatedTokens: Number(row.plan_estimated_tokens),
      status: row.plan_status,
      source: row.plan_source,
      providerModel: row.plan_provider_model,
      promptVersion: row.plan_prompt_version,
      rationale: row.plan_rationale,
    },
    intent: intent ? {
      version: intent.version,
      publicId: intent.public_id,
      schemaVersion: intent.schema_version,
      lifecycleStatus: intent.lifecycle_status,
      productLine: intent.product_line,
      contentHash: intent.content_hash,
      objective: intent.objective,
      audience: typeof intent.audience === "string" ? JSON.parse(intent.audience) : intent.audience,
      budget: typeof intent.budget === "string" ? JSON.parse(intent.budget) : intent.budget,
      dataScope: typeof intent.data_scope === "string" ? JSON.parse(intent.data_scope) : intent.data_scope,
      compliance: typeof intent.compliance === "string" ? JSON.parse(intent.compliance) : intent.compliance,
      requestedMethods: typeof intent.requested_methods === "string" ? JSON.parse(intent.requested_methods) : intent.requested_methods,
      assumptions: typeof intent.assumptions === "string" ? JSON.parse(intent.assumptions) : intent.assumptions,
      openQuestions: typeof intent.open_questions === "string" ? JSON.parse(intent.open_questions) : intent.open_questions,
      promptVersion: intent.prompt_version,
      providerModel: intent.provider_model,
      context: intent.retrieval_public_id ? {
        retrievalPublicId: intent.retrieval_public_id,
        purpose: intent.retrieval_purpose ?? "intent_planning",
        policyVersion: intent.retrieval_policy_version ?? "memory-policy-v1",
        policyDecision: intent.retrieval_policy_decision
          ? typeof intent.retrieval_policy_decision === "string"
            ? JSON.parse(intent.retrieval_policy_decision)
            : intent.retrieval_policy_decision
          : {},
        citationCount: intent.citation_count,
      } : null,
    } : null,
    workflow: workflow ? {
      publicId: workflow.public_id,
      version: workflow.version,
      schemaVersion: workflow.schema_version,
      workflowType: workflow.workflow_type,
      templateVersion: workflow.template_version,
      compilerVersion: workflow.compiler_version,
      contentHash: workflow.content_hash,
      taskCount: workflow.task_count,
      skillRequirements: typeof workflow.skill_requirements === "string"
        ? JSON.parse(workflow.skill_requirements)
        : workflow.skill_requirements,
      runtimeLimits: typeof workflow.runtime_limits === "string"
        ? JSON.parse(workflow.runtime_limits)
        : workflow.runtime_limits,
    } : null,
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
      publicId: run.public_id,
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
      maxAttempts: task.max_attempts,
      nextAttemptAt: task.next_attempt_at,
      lastErrorCode: task.last_error_code,
      lastErrorClass: task.last_error_class,
      retryable: task.retryable,
      waitingReason: task.waiting_reason,
      waitingPayload: task.waiting_payload ? (typeof task.waiting_payload === "string" ? JSON.parse(task.waiting_payload) : task.waiting_payload) : null,
      resumedAt: task.resumed_at,
      resumeCount: task.resume_count,
      startedAt: task.started_at,
      finishedAt: task.finished_at,
      origin: task.origin,
      generation: task.generation,
      reasoningDecisionPublicId: task.reasoning_decision_public_id,
      attempts: attemptsByTask.get(task.public_id) ?? [],
      inputRequest: inputByTask.get(task.public_id) ?? null,
    })),
    reasoningDecisions: decisionsResult.rows.map((decision) => ({
      publicId: decision.public_id,
      runId: decision.run_id,
      sequence: decision.sequence,
      triggerType: decision.trigger_type,
      policyVersion: decision.policy_version,
      metrics: typeof decision.metrics === "string" ? JSON.parse(decision.metrics) : decision.metrics,
      budget: typeof decision.budget_snapshot === "string" ? JSON.parse(decision.budget_snapshot) : decision.budget_snapshot,
      chosenAction: typeof decision.chosen_action === "string" ? JSON.parse(decision.chosen_action) : decision.chosen_action,
      reason: decision.reason,
      createdAt: decision.created_at,
      candidates: (typeof decision.candidates === "string" ? JSON.parse(decision.candidates) : decision.candidates) as StudyDetail["reasoningDecisions"][number]["candidates"],
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
          evidenceGraph,
        }
      : null,
  };
}
