import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { Viewer } from "@/lib/auth";
import {
  describeOpenAIError,
  generateProviderResearchReport,
  generateProviderStudyPlan,
  getOpenAIProviderStatus,
  type ResearchCitation,
  type ResearchProgressEvent,
  type ResearchReport,
  type SyntheticPanelResearch,
} from "@/lib/openai-provider";

export type StudyMethod = "Interview Chat" | "Discussion Chat" | "Scout Agent" | "Fast Insight";

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
    content: string;
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
  } | null;
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

export async function createStudy(viewer: Viewer, briefInput: string) {
  const database = await getDatabase();
  const brief = briefInput.trim();
  const localPlan = derivePlan(brief);
  const providerStatus = getOpenAIProviderStatus();
  let providerFailure: ReturnType<typeof describeOpenAIError> | null = null;
  let providerPlan: Awaited<ReturnType<typeof generateProviderStudyPlan>> | null = null;

  if (providerStatus.configured) {
    try {
      providerPlan = await generateProviderStudyPlan(brief, viewer.userPublicId);
    } catch (error) {
      providerFailure = describeOpenAIError(error);
    }
  }

  const plan = providerPlan ?? {
    ...localPlan,
    source: "local_rules" as const,
    responseId: null,
    model: null,
    promptVersion: "local-plan-v1",
  };
  const publicId = createPublicId("std");
  const title = createStudyTitle(brief);

  return database.transaction(async (transaction) => {
    const studyResult = await transaction.query<{ id: string }>(
      `insert into studies (
         public_id, workspace_id, created_by, title, brief, study_type, status,
         current_stage, estimated_tokens
       ) values ($1, $2, $3, $4, $5, $6, 'awaiting_confirmation', 'confirmation', $7)
       returning id::text as id`,
      [
        publicId,
        viewer.workspaceId,
        viewer.userId,
        title,
        brief,
        plan.studyType,
        plan.estimatedTokens,
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
        plan.source === "openai"
          ? "OpenAI 已根据 Brief 生成结构化研究计划，等待确认。"
          : providerStatus.configured
            ? "模型计划生成暂时失败，已保留一份本地规则草案供确认。"
            : "当前未配置 OpenAI API Key，已生成本地规则草案供确认。",
      ],
    );

    await transaction.query(
      "insert into study_events (study_id, event_type, payload) values ($1, 'plan.created', $2::jsonb)",
      [studyId, JSON.stringify({
        source: plan.source,
        promptVersion: plan.promptVersion,
        responseId: plan.responseId,
        model: plan.model,
        fallbackError: providerFailure,
      })],
    );

    return publicId;
  });
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
    await transaction.query(
      "insert into study_runs (study_id, status) values ($1, 'awaiting_provider')",
      [study.id],
    );
    await transaction.query(
      "insert into study_events (study_id, event_type) values ($1, 'plan.confirmed')",
      [study.id],
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
      [study.study_id, JSON.stringify({ provider: "openai", requiredVariable: "OPENAI_API_KEY" })],
    );
    return "provider_missing" as const;
  }

  const claim = await database.query<{ id: string }>(
    `update study_runs
     set status = 'running', provider = 'openai', provider_model = $2, started_at = now(), error_message = null
     where id = $1 and status in ('awaiting_provider', 'queued')
     returning id::text as id`,
    [study.run_id, providerStatus.researchModel],
  );

  if (claim.rows.length === 0) {
    return study.run_status === "completed" ? "completed" as const : "already_running" as const;
  }

  await database.query(
    `update studies set status = 'running', current_stage = 'execution', updated_at = now() where id = $1`,
    [study.study_id],
  );
  await database.query(
    "insert into study_events (study_id, event_type, payload) values ($1, 'run.started', $2::jsonb)",
    [study.study_id, JSON.stringify({ provider: "openai", model: providerStatus.researchModel })],
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
    });
    const reportPublicId = createPublicId("rpt");
    const contentJson = { ...providerResult.report, citations: providerResult.citations };
    const totalTokens = getTotalTokens(providerResult.usage);

    await database.transaction(async (transaction) => {
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
        "insert into study_events (study_id, event_type, payload) values ($1, 'report.completed', $2::jsonb)",
        [study.study_id, JSON.stringify({
          provider: "openai",
          responseId: providerResult.responseId,
          model: providerResult.model,
          promptVersion: providerResult.promptVersion,
          citationCount: providerResult.citations.length,
          totalTokens,
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
        "insert into study_events (study_id, event_type, payload) values ($1, 'run.failed', $2::jsonb)",
        [study.study_id, JSON.stringify(providerError)],
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
    }>(
      `select
         studies.id::text as study_id,
         study_plans.status as plan_status,
         latest_run.id as run_id,
         latest_run.status as run_status
       from studies
       join study_plans on study_plans.study_id = studies.id
       left join lateral (
         select study_runs.id::text as id, study_runs.status
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

    if (study.run_status === "running" || study.run_status === "queued") {
      return "already_running" as const;
    }

    if (study.run_id && study.run_status === "awaiting_provider") {
      await transaction.query(
        "update study_runs set status = 'queued', provider = 'openai', provider_model = $2 where id = $1",
        [study.run_id, providerStatus.researchModel],
      );
    } else {
      await transaction.query(
        `insert into study_runs (study_id, status, provider, provider_model)
         values ($1, 'queued', 'openai', $2)`,
        [study.study_id, providerStatus.researchModel],
      );
    }

    await transaction.query(
      `update studies set status = 'queued', current_stage = 'execution', updated_at = now() where id = $1`,
      [study.study_id],
    );
    await transaction.query(
      "insert into study_events (study_id, event_type, payload) values ($1, 'run.queued', $2::jsonb)",
      [study.study_id, JSON.stringify({ provider: "openai", model: providerStatus.researchModel })],
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
    run_status: string | null;
    run_provider: string | null;
    run_model: string | null;
    run_error: string | null;
    report_public_id: string | null;
    report_title: string | null;
    report_content: (ResearchReport & { citations?: ResearchCitation[] }) | string | null;
    report_generated_at: string | null;
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
       latest_run.status as run_status,
       latest_run.provider as run_provider,
       latest_run.provider_model as run_model,
       latest_run.error_message as run_error,
       reports.public_id as report_public_id,
       reports.title as report_title,
       reports.content_json as report_content,
       reports.generated_at::text as report_generated_at,
       studies.updated_at::text as updated_at
     from studies
     join study_plans on study_plans.study_id = studies.id
     left join reports on reports.study_id = studies.id
     left join lateral (
       select study_runs.status, study_runs.provider, study_runs.provider_model, study_runs.error_message
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

  const messagesResult = await database.query<{
    id: string;
    role: StudyDetail["messages"][number]["role"];
    content: string | null;
    created_at: string;
  }>(
    `select id::text as id, role, content, created_at::text as created_at
     from study_messages
     where study_id = $1
     order by created_at asc, id asc`,
    [row.id],
  );

  const methods = typeof row.methods === "string" ? JSON.parse(row.methods) : row.methods;
  const personaFilters =
    typeof row.persona_filters === "string" ? JSON.parse(row.persona_filters) : row.persona_filters;
  const reportContent = typeof row.report_content === "string"
    ? JSON.parse(row.report_content)
    : row.report_content;

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
      content: message.content ?? "",
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
    report: row.report_public_id && row.report_title && reportContent && row.report_generated_at
      ? {
          publicId: row.report_public_id,
          title: row.report_title,
          content: reportContent,
          citations: reportContent.citations ?? [],
          generatedAt: row.report_generated_at,
        }
      : null,
  };
}
