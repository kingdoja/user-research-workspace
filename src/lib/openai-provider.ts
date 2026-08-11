import { createHash } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import type { StudyMethod } from "@/lib/studies";
import { collectPublicWebSources } from "@/lib/public-web-search";

const DEFAULT_MODEL = "gpt-5.6-terra";
const PLAN_PROMPT_VERSION = "study-plan-v1";
const REPORT_PROMPT_VERSION = "public-web-research-v2";

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

export type ProviderStudyPlan = z.infer<typeof planSchema> & {
  source: "openai";
  responseId: string;
  model: string;
  promptVersion: string;
};

export type ResearchReport = z.infer<typeof reportSchema>;

export type ResearchCitation = {
  title: string;
  url: string;
};

export type ProviderResearchReport = {
  report: ResearchReport;
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
}): Promise<ProviderResearchReport> {
  const model = getResearchModel();
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
  const sources = await collectPublicWebSources(queries, sourcePlan.seedUrls);

  if (sources.length < 3) {
    throw new Error("PUBLIC_WEB_SOURCES_INSUFFICIENT");
  }

  const evidencePacket = sources.map((source, index) => (
    `[S${index + 1}] ${source.title}\nURL: ${source.url}\n公开网页摘录：${source.excerpt}`
  )).join("\n\n");
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
      "清楚区分公开来源事实、分析推断和建议。不要声称完成了真人访谈、焦点小组、私域社媒抓取或 Persona 模拟。",
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
    citations: sources.map(({ title, url }) => ({ title, url })),
    responseId: response.id,
    model: response.model,
    promptVersion: REPORT_PROMPT_VERSION,
    usage: response.usage,
  };
}
