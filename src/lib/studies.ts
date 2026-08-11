import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { Viewer } from "@/lib/auth";

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
  };
  runStatus: string | null;
};

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

  const methods: StudyMethod[] = wantsFastInsight
    ? ["Fast Insight"]
    : wantsPanelOnly
      ? []
      : [
          ...(needsScout ? (["Scout Agent"] as StudyMethod[]) : []),
          ...(needsDiscussion ? (["Discussion Chat"] as StudyMethod[]) : []),
          "Interview Chat",
        ];

  const estimatedDurationMinutes = wantsFastInsight ? 180 : needsScout ? 2880 : 240;
  const estimatedTokens = wantsFastInsight ? 35000 : needsScout ? 120000 : personaCount * 12000;

  return {
    studyType,
    framework,
    methods,
    personaFilters: {
      audience: "由 Brief 与后续澄清确定",
      source: needsScout ? "公众人设库 + Scout 生成" : "公众人设库",
    },
    personaCount,
    estimatedDurationMinutes,
    estimatedTokens,
  };
}

export async function createStudy(viewer: Viewer, briefInput: string) {
  const database = await getDatabase();
  const brief = briefInput.trim();
  const plan = derivePlan(brief);
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
         estimated_duration_minutes, estimated_tokens
       ) values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)`,
      [
        studyId,
        plan.framework,
        JSON.stringify(plan.methods),
        JSON.stringify(plan.personaFilters),
        plan.personaCount,
        plan.estimatedDurationMinutes,
        plan.estimatedTokens,
      ],
    );

    await transaction.query(
      `insert into study_messages (study_id, role, content)
       values ($1, 'user', $2), ($1, 'assistant', $3)`,
      [studyId, brief, "研究计划已生成，等待确认。"],
    );

    await transaction.query(
      "insert into study_events (study_id, event_type, payload) values ($1, 'plan.created', $2::jsonb)",
      [studyId, JSON.stringify({ source: "local_rules", version: 1 })],
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
    run_status: string | null;
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
       latest_run.status as run_status,
       studies.updated_at::text as updated_at
     from studies
     join study_plans on study_plans.study_id = studies.id
     left join lateral (
       select study_runs.status
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
    },
    runStatus: row.run_status,
  };
}
