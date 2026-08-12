import { createHash } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import type { StudyMethod } from "@/lib/studies";
import { collectPublicWebSources } from "@/lib/public-web-search";

const DEFAULT_MODEL = "gpt-5.6-terra";
const PLAN_PROMPT_VERSION = "study-plan-v1";
const REPORT_PROMPT_VERSION = "synthetic-panel-research-v1";

const searchSourcePlanSchema = z.object({
  queries: z.array(z.string().min(3)).min(3),
  seedUrls: z.array(z.string().min(10)).min(4),
});

const searchSourcePlanJsonSchema = {
  type: "object",
  properties: {
    queries: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 3, maxLength: 120 },
    },
    seedUrls: {
      type: "array",
      minItems: 4,
      maxItems: 16,
      items: { type: "string", minLength: 10, maxLength: 500 },
    },
  },
  required: ["queries", "seedUrls"],
  additionalProperties: false,
} as const;

const planSchema = z.object({
  studyType: z.enum(["user_research", "fast_insight", "product_rnd", "panel_only"]),
  framework: z.string().min(2),
  methods: z.array(z.enum(["Interview Chat", "Discussion Chat", "Scout Agent", "Fast Insight"])),
  personaFilters: z.object({
    audience: z.string().min(2),
    source: z.string().min(2),
  }),
  personaCount: z.number().int().min(1).max(20),
  estimatedDurationMinutes: z.number().int().min(30).max(4320),
  estimatedTokens: z.number().int().min(10000).max(250000),
  rationale: z.string().min(20),
});

const reportSchema = z.object({
  title: z.string().min(4),
  executiveSummary: z.string().min(80),
  findings: z.array(z.object({
    title: z.string().min(2),
    insight: z.string().min(40),
    evidence: z.string().min(30),
    implication: z.string().min(30),
  })).min(3),
  recommendations: z.array(z.object({
    title: z.string().min(2),
    action: z.string().min(30),
    rationale: z.string().min(20),
    priority: z.enum(["high", "medium", "low"]),
  })).min(3),
  limitations: z.array(z.string().min(10)).min(1),
  nextQuestions: z.array(z.string().min(10)).min(2),
});

const personaSchema = z.object({
  name: z.string().min(2),
  archetype: z.string().min(2),
  age: z.number().int().min(18).max(75),
  city: z.string().min(2),
  occupation: z.string().min(2),
  commute: z.string().min(5),
  budget: z.string().min(2),
  currentSituation: z.string().min(10),
  goals: z.array(z.string().min(4)).min(2).max(4),
  painPoints: z.array(z.string().min(4)).min(2).max(4),
  decisionStyle: z.string().min(8),
  tags: z.array(z.string().min(2)).min(3).max(5),
});

const panelResearchSchema = z.object({
  panel: z.object({
    title: z.string().min(4),
    description: z.string().min(20),
  }),
  personas: z.array(personaSchema).min(6).max(8),
  interviews: z.array(z.object({
    personaName: z.string().min(2),
    batch: z.number().int().min(1).max(2),
    objective: z.string().min(10),
    summary: z.string().min(40),
    quotes: z.array(z.string().min(10)).min(2).max(4),
    insights: z.array(z.string().min(10)).min(2).max(4),
  })).min(6).max(8),
  validation: z.object({
    directions: z.array(z.object({
      title: z.string().min(4),
      appeal: z.string().min(20),
      resistance: z.string().min(20),
      verdict: z.enum(["strong", "mixed", "weak"]),
    })).min(2).max(4),
    summary: z.string().min(40),
  }),
});

const planJsonSchema = {
  type: "object",
  properties: {
    studyType: { type: "string", enum: ["user_research", "fast_insight", "product_rnd", "panel_only"] },
    framework: { type: "string", minLength: 2, maxLength: 120 },
    methods: {
      type: "array",
      maxItems: 4,
      items: { type: "string", enum: ["Interview Chat", "Discussion Chat", "Scout Agent", "Fast Insight"] },
    },
    personaFilters: {
      type: "object",
      properties: {
        audience: { type: "string", minLength: 2, maxLength: 240 },
        source: { type: "string", minLength: 2, maxLength: 120 },
      },
      required: ["audience", "source"],
      additionalProperties: false,
    },
    personaCount: { type: "integer", minimum: 1, maximum: 20 },
    estimatedDurationMinutes: { type: "integer", minimum: 30, maximum: 4320 },
    estimatedTokens: { type: "integer", minimum: 10000, maximum: 250000 },
    rationale: { type: "string", minLength: 20, maxLength: 1200 },
  },
  required: [
    "studyType",
    "framework",
    "methods",
    "personaFilters",
    "personaCount",
    "estimatedDurationMinutes",
    "estimatedTokens",
    "rationale",
  ],
  additionalProperties: false,
} as const;

const reportJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 4, maxLength: 160 },
    executiveSummary: { type: "string", minLength: 80, maxLength: 3000 },
    findings: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 2, maxLength: 120 },
          insight: { type: "string", minLength: 40, maxLength: 1600 },
          evidence: { type: "string", minLength: 30, maxLength: 1600 },
          implication: { type: "string", minLength: 30, maxLength: 1200 },
        },
        required: ["title", "insight", "evidence", "implication"],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 2, maxLength: 120 },
          action: { type: "string", minLength: 30, maxLength: 1200 },
          rationale: { type: "string", minLength: 20, maxLength: 800 },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["title", "action", "rationale", "priority"],
        additionalProperties: false,
      },
    },
    limitations: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "string", minLength: 10, maxLength: 600 },
    },
    nextQuestions: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: { type: "string", minLength: 10, maxLength: 400 },
    },
  },
  required: ["title", "executiveSummary", "findings", "recommendations", "limitations", "nextQuestions"],
  additionalProperties: false,
} as const;

const panelResearchJsonSchema = {
  type: "object",
  properties: {
    panel: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 4, maxLength: 80 },
        description: { type: "string", minLength: 20, maxLength: 500 },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
    personas: {
      type: "array",
      minItems: 6,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 2, maxLength: 40 },
          archetype: { type: "string", minLength: 2, maxLength: 80 },
          age: { type: "integer", minimum: 18, maximum: 75 },
          city: { type: "string", minLength: 2, maxLength: 40 },
          occupation: { type: "string", minLength: 2, maxLength: 80 },
          commute: { type: "string", minLength: 5, maxLength: 240 },
          budget: { type: "string", minLength: 2, maxLength: 80 },
          currentSituation: { type: "string", minLength: 10, maxLength: 500 },
          goals: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 4, maxLength: 160 } },
          painPoints: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 4, maxLength: 160 } },
          decisionStyle: { type: "string", minLength: 8, maxLength: 300 },
          tags: { type: "array", minItems: 3, maxItems: 5, items: { type: "string", minLength: 2, maxLength: 30 } },
        },
        required: ["name", "archetype", "age", "city", "occupation", "commute", "budget", "currentSituation", "goals", "painPoints", "decisionStyle", "tags"],
        additionalProperties: false,
      },
    },
    interviews: {
      type: "array",
      minItems: 6,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          personaName: { type: "string", minLength: 2, maxLength: 40 },
          batch: { type: "integer", minimum: 1, maximum: 2 },
          objective: { type: "string", minLength: 10, maxLength: 300 },
          summary: { type: "string", minLength: 40, maxLength: 1200 },
          quotes: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 10, maxLength: 300 } },
          insights: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 10, maxLength: 300 } },
        },
        required: ["personaName", "batch", "objective", "summary", "quotes", "insights"],
        additionalProperties: false,
      },
    },
    validation: {
      type: "object",
      properties: {
        directions: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 4, maxLength: 100 },
              appeal: { type: "string", minLength: 20, maxLength: 500 },
              resistance: { type: "string", minLength: 20, maxLength: 500 },
              verdict: { type: "string", enum: ["strong", "mixed", "weak"] },
            },
            required: ["title", "appeal", "resistance", "verdict"],
            additionalProperties: false,
          },
        },
        summary: { type: "string", minLength: 40, maxLength: 1000 },
      },
      required: ["directions", "summary"],
      additionalProperties: false,
    },
  },
  required: ["panel", "personas", "interviews", "validation"],
  additionalProperties: false,
} as const;

export type ProviderStudyPlan = z.infer<typeof planSchema> & {
  source: "openai";
  responseId: string;
  model: string;
  promptVersion: string;
};

export type ResearchReport = z.infer<typeof reportSchema>;
export type SyntheticPanelResearch = z.infer<typeof panelResearchSchema>;

export type ResearchProgressEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

export type ResearchCitation = {
  title: string;
  url: string;
};

export type ProviderResearchReport = {
  report: ResearchReport;
  panelResearch: SyntheticPanelResearch;
  citations: ResearchCitation[];
  responseId: string;
  model: string;
  promptVersion: string;
  usage: unknown;
};

let client: OpenAI | null = null;

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY_MISSING");
  }

  client ??= new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
  });
  return client;
}

function getPlanModel() {
  return process.env.OPENAI_PLAN_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

function getResearchModel() {
  return process.env.OPENAI_RESEARCH_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

function safetyIdentifier(userPublicId: string) {
  return createHash("sha256").update(userPublicId).digest("hex");
}

function parseOutput<T>(outputText: string, schema: z.ZodType<T>) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error("OPENAI_INVALID_JSON");
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    throw new Error("OPENAI_INVALID_SCHEMA");
  }

  return result.data;
}

export function getOpenAIProviderStatus() {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    planModel: getPlanModel(),
    researchModel: getResearchModel(),
  };
}

export function describeOpenAIError(error: unknown) {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 524) {
      return {
        message: "上游模型服务响应超时，请稍后重新执行。",
        status: error.status,
        code: error.code ?? "UPSTREAM_TIMEOUT",
        requestId: error.requestID ?? null,
      };
    }

    return {
      message: error.message.slice(0, 500),
      status: error.status ?? null,
      code: error.code ?? null,
      requestId: error.requestID ?? null,
    };
  }

  if (error instanceof Error && error.message === "OPENAI_INVALID_SCHEMA") {
    return {
      message: "模型返回的研究结构不完整，请重新执行。",
      status: null,
      code: error.message,
      requestId: null,
    };
  }

  if (error instanceof Error && error.message === "OPENAI_INVALID_JSON") {
    return {
      message: "模型返回的内容无法解析，请重新执行。",
      status: null,
      code: error.message,
      requestId: null,
    };
  }

  if (error instanceof Error && error.message === "PUBLIC_WEB_SOURCES_INSUFFICIENT") {
    return {
      message: "可核查的公开网页来源不足，请补充更具体的产品、地区或时间范围后重试。",
      status: null,
      code: error.message,
      requestId: null,
    };
  }

  return {
    message: error instanceof Error ? error.message.slice(0, 500) : "OPENAI_UNKNOWN_ERROR",
    status: null,
    code: null,
    requestId: null,
  };
}

export async function generateProviderStudyPlan(brief: string, userPublicId: string): Promise<ProviderStudyPlan> {
  const model = getPlanModel();
  const response = await getClient().responses.create({
    model,
    reasoning: { effort: "low" },
    safety_identifier: safetyIdentifier(userPublicId),
    store: true,
    metadata: { surface: "study_plan", prompt_version: PLAN_PROMPT_VERSION },
    instructions: [
      "你是商业研究设计师。把用户 Brief 转换成可执行、克制且透明的研究计划。",
      "方法只能从给定枚举中选择。不要声称已经完成访谈、抓取、Persona 模拟或数据收集。",
      "如果用户要求仅使用公开网页或公开资料，方法只能选择 Scout Agent 和/或 Fast Insight，不得选择 Interview Chat 或 Discussion Chat。",
      "personaFilters.source 应说明计划使用公开网页研究；如果方法包含访谈，它仅代表后续待实现的方法，不代表已招募真人。",
      "估算值用于产品排期，不代表 OpenAI API 的实际计费 Token。输出使用简体中文。",
    ].join("\n"),
    input: brief,
    text: {
      format: {
        type: "json_schema",
        name: "study_plan",
        strict: true,
        schema: planJsonSchema,
      },
    },
  });

  const plan = parseOutput(response.output_text, planSchema);

  return {
    ...plan,
    methods: plan.methods as StudyMethod[],
    source: "openai",
    responseId: response.id,
    model: response.model,
    promptVersion: PLAN_PROMPT_VERSION,
  };
}

export async function generateProviderResearchReport(input: {
  brief: string;
  framework: string;
  methods: StudyMethod[];
  audience: string;
  userPublicId: string;
  studyPublicId: string;
  onProgress?: (event: ResearchProgressEvent) => Promise<void> | void;
}): Promise<ProviderResearchReport> {
  const emit = async (type: string, payload: Record<string, unknown> = {}) => {
    await input.onProgress?.({ type, payload });
  };
  const model = getResearchModel();
  await emit("trend.scan.started", { focus: "category_and_charging" });
  const queryResponse = await getClient().responses.create({
    model,
    reasoning: { effort: "low" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: false,
    metadata: {
      surface: "public_web_query_planning",
      prompt_version: REPORT_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "把商业研究 Brief 转换成公开网页检索计划。",
      "queries 提供 3 到 5 条适合网页搜索的短检索词，同时覆盖中文和英文，不要使用只有地区或年份的宽泛词。",
      "seedUrls 提供 4 到 16 个你已知且最可能真实存在的 https 官方页面，优先选择产品、定价、隐私、安全、服务条款和客户案例页面。",
      "seedUrls 不得使用搜索结果页、百科、门户首页或虚构路径；不确定时宁可给供应商官网首页。",
      "同时覆盖中文和英文公开网页；包含核心品类、关键维度、地区与时间范围。",
      "不要添加解释。",
    ].join("\n"),
    input: `研究 Brief：${input.brief}\n研究框架：${input.framework}`,
    text: {
      format: {
        type: "json_schema",
        name: "public_web_source_plan",
        strict: true,
        schema: searchSourcePlanJsonSchema,
      },
    },
  });
  const sourcePlan = parseOutput(queryResponse.output_text, searchSourcePlanSchema);
  const queries = sourcePlan.queries.slice(0, 5);
  await emit("search.plan.completed", { queryCount: queries.length, queries });
  const sourceResult = await collectPublicWebSources(queries, sourcePlan.seedUrls);
  const sources = sourceResult.sources;

  if (sources.length < 3) {
    throw new Error("PUBLIC_WEB_SOURCES_INSUFFICIENT");
  }

  const sourceSummary = sources.map(({ title, url }) => ({ title, url }));
  const firstThird = Math.max(1, Math.ceil(sources.length / 3));
  const secondThird = Math.max(firstThird + 1, Math.ceil(sources.length * 2 / 3));
  await emit("trend.scan.completed", {
    focus: "category_and_charging",
    sourceCount: firstThird,
    sources: sourceSummary.slice(0, firstThird),
    provider: sourceResult.metadata.primaryProvider,
  });
  await emit("upgrade.scan.completed", {
    focus: "replacement_and_brand_upgrade",
    sourceCount: secondThird - firstThird,
    sources: sourceSummary.slice(firstThird, secondThird),
  });
  await emit("policy.research.completed", {
    focus: "policy_and_industry_context",
    sourceCount: sources.length - secondThird,
    sources: sourceSummary.slice(secondThird),
    fallbackUsed: sourceResult.metadata.fallbackUsed,
  });

  const evidencePacket = sources.map((source, index) => (
    `[S${index + 1}] ${source.title}\nURL: ${source.url}\n公开网页摘录：${source.excerpt}`
  )).join("\n\n");
  await emit("personas.generate.started", { targetCount: 8 });
  const panelResponse = await getClient().responses.create({
    model,
    reasoning: { effort: "medium" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "synthetic_persona_panel",
      prompt_version: REPORT_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是研究模拟系统。仅根据 Brief 与公开网页证据构建 6 到 8 个差异化的 AI 合成 Persona，并进行透明标注的模拟访谈。",
      "Persona 不是现实中的真人，quotes 是基于 Persona 约束生成的模拟回答，不得写成真实受访者原话或统计代表性证据。",
      "覆盖不同城市、年龄、职业、预算、决策风格与使用情境，避免刻板印象和仅改名字的重复画像。",
      "将访谈分为两批：第一批关注决策路径，第二批关注体验、焦虑或关键使用问题。每个 Persona 只出现一次。",
      "validation 用 Panel 的模拟回答评估 2 到 4 个产品或策略方向，并明确吸引力与阻力。输出简体中文。",
    ].join("\n"),
    input: [
      `研究 Brief：${input.brief}`,
      `研究框架：${input.framework}`,
      `目标受众：${input.audience}`,
      `计划方法：${input.methods.join("、") || "AI 合成 Persona 模拟"}`,
      `公开网页证据包：\n${evidencePacket}`,
    ].join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "synthetic_panel_research",
        strict: true,
        schema: panelResearchJsonSchema,
      },
    },
  });
  const panelResearch = parseOutput(panelResponse.output_text, panelResearchSchema);
  await emit("personas.generated", {
    count: panelResearch.personas.length,
    names: panelResearch.personas.map((persona) => persona.name),
  });
  await emit("panel.created", {
    title: panelResearch.panel.title,
    count: panelResearch.personas.length,
  });
  const batchOne = panelResearch.interviews.filter((interview) => interview.batch === 1);
  const batchTwo = panelResearch.interviews.filter((interview) => interview.batch === 2);
  await emit("interviews.batch1.completed", {
    participantCount: batchOne.length,
    participants: batchOne.map((interview) => interview.personaName),
  });
  await emit("interviews.batch2.completed", {
    participantCount: batchTwo.length,
    participants: batchTwo.map((interview) => interview.personaName),
  });
  await emit("validation.completed", {
    directionCount: panelResearch.validation.directions.length,
    directions: panelResearch.validation.directions.map(({ title, verdict }) => ({ title, verdict })),
  });
  await emit("report.synthesis.started", {
    evidenceCharacters: evidencePacket.length,
    personaCount: panelResearch.personas.length,
    interviewCount: panelResearch.interviews.length,
  });
  const response = await getClient().responses.create({
    model,
    reasoning: { effort: "medium" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "public_web_research",
      prompt_version: REPORT_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是严谨的商业研究员。只根据输入中的公开网页证据包生成可审计的中文报告。",
      "清楚区分公开来源事实、AI 合成 Persona 模拟、分析推断和建议。不得把模拟访谈写成真人研究或具有统计代表性的证据。",
      "每条 finding.evidence 都要引用对应的 [S编号]；证据不足时必须写入 limitations，不得补造来源或数字。",
      "没有买方侧直接证据时，不得在标题、洞察或总结中使用“最关注、首要、普遍、主要偏好”等排序断言；规范性建议应使用“应当、可作为、建议”措辞，并明确它不是已验证的市场事实。",
      "搜索摘要可能不完整，涉及采购或合规决策时应建议复核原始页面。优先采用近期、权威且彼此独立的来源。",
      "报告应直接服务业务决策，避免泛泛而谈。",
    ].join("\n"),
    input: [
      `研究 Brief：${input.brief}`,
      `研究框架：${input.framework}`,
      `计划方法：${input.methods.join("、") || "公开网页研究"}`,
      `目标受众：${input.audience}`,
      `实际检索词：${queries.join("；")}`,
      `公开网页证据包：\n${evidencePacket}`,
      `AI 合成 Panel 模拟：\n${JSON.stringify(panelResearch)}`,
      "请给出关键发现、证据、业务含义、行动建议、局限与下一步问题。",
    ].join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "public_web_research_report",
        strict: true,
        schema: reportJsonSchema,
      },
    },
  });

  return {
    report: parseOutput(response.output_text, reportSchema),
    panelResearch,
    citations: sources.map(({ title, url }) => ({ title, url })),
    responseId: response.id,
    model: response.model,
    promptVersion: REPORT_PROMPT_VERSION,
    usage: response.usage,
  };
}
