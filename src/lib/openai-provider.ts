import { createHash } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import type { StudyMethod } from "@/lib/studies";

const DEFAULT_MODEL = "gpt-5.6-terra";
const PLAN_PROMPT_VERSION = "study-plan-v1";
const REPORT_PROMPT_VERSION = "public-web-research-v1";

const planSchema = z.object({
  studyType: z.enum(["user_research", "fast_insight", "product_rnd", "panel_only"]),
  framework: z.string().min(2).max(120),
  methods: z.array(z.enum(["Interview Chat", "Discussion Chat", "Scout Agent", "Fast Insight"])).max(4),
  personaFilters: z.object({
    audience: z.string().min(2).max(240),
    source: z.string().min(2).max(120),
  }),
  personaCount: z.number().int().min(1).max(20),
  estimatedDurationMinutes: z.number().int().min(30).max(4320),
  estimatedTokens: z.number().int().min(10000).max(250000),
  rationale: z.string().min(20).max(1200),
});

const reportSchema = z.object({
  title: z.string().min(4).max(160),
  executiveSummary: z.string().min(80).max(3000),
  findings: z.array(z.object({
    title: z.string().min(2).max(120),
    insight: z.string().min(40).max(1600),
    evidence: z.string().min(30).max(1600),
    implication: z.string().min(30).max(1200),
  })).min(3).max(6),
  recommendations: z.array(z.object({
    title: z.string().min(2).max(120),
    action: z.string().min(30).max(1200),
    rationale: z.string().min(20).max(800),
    priority: z.enum(["high", "medium", "low"]),
  })).min(3).max(6),
  limitations: z.array(z.string().min(10).max(600)).min(1).max(6),
  nextQuestions: z.array(z.string().min(10).max(400)).min(2).max(6),
});

const planJsonSchema = {
  type: "object",
  properties: {
    studyType: { type: "string", enum: ["user_research", "fast_insight", "product_rnd", "panel_only"] },
    framework: { type: "string" },
    methods: {
      type: "array",
      items: { type: "string", enum: ["Interview Chat", "Discussion Chat", "Scout Agent", "Fast Insight"] },
    },
    personaFilters: {
      type: "object",
      properties: {
        audience: { type: "string" },
        source: { type: "string" },
      },
      required: ["audience", "source"],
      additionalProperties: false,
    },
    personaCount: { type: "integer", minimum: 1, maximum: 20 },
    estimatedDurationMinutes: { type: "integer", minimum: 30, maximum: 4320 },
    estimatedTokens: { type: "integer", minimum: 10000, maximum: 250000 },
    rationale: { type: "string" },
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
    title: { type: "string" },
    executiveSummary: { type: "string" },
    findings: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          insight: { type: "string" },
          evidence: { type: "string" },
          implication: { type: "string" },
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
          title: { type: "string" },
          action: { type: "string" },
          rationale: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["title", "action", "rationale", "priority"],
        additionalProperties: false,
      },
    },
    limitations: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
    nextQuestions: { type: "array", minItems: 2, maxItems: 6, items: { type: "string" } },
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

type Annotation = {
  type?: string;
  title?: string;
  url?: string;
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

function collectCitations(output: unknown): ResearchCitation[] {
  if (!Array.isArray(output)) {
    return [];
  }

  const citations = new Map<string, ResearchCitation>();

  for (const item of output) {
    if (!item || typeof item !== "object" || !("content" in item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (!content || typeof content !== "object" || !("annotations" in content) || !Array.isArray(content.annotations)) {
        continue;
      }

      for (const annotation of content.annotations as Annotation[]) {
        if (annotation.type !== "url_citation" || !annotation.url) {
          continue;
        }

        try {
          const url = new URL(annotation.url);

          if (url.protocol !== "https:" && url.protocol !== "http:") {
            continue;
          }
        } catch {
          continue;
        }

        citations.set(annotation.url, {
          title: annotation.title?.trim() || annotation.url,
          url: annotation.url,
        });
      }
    }
  }

  return [...citations.values()];
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
    return {
      message: error.message.slice(0, 500),
      status: error.status ?? null,
      code: error.code ?? null,
      requestId: error.requestID ?? null,
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
      "你是严谨的商业研究员。使用 web_search 对公开网页进行研究，并生成可审计的中文报告。",
      "清楚区分公开来源事实、分析推断和建议。不要声称完成了真人访谈、焦点小组、私域社媒抓取或 Persona 模拟。",
      "证据不足时必须写入 limitations。优先采用近期、权威且彼此独立的来源。",
      "报告应直接服务业务决策，避免泛泛而谈。",
    ].join("\n"),
    input: [
      `研究 Brief：${input.brief}`,
      `研究框架：${input.framework}`,
      `计划方法：${input.methods.join("、") || "公开网页研究"}`,
      `目标受众：${input.audience}`,
      "请围绕该问题检索公开资料，给出关键发现、证据、业务含义、行动建议、局限与下一步问题。",
    ].join("\n\n"),
    tools: [{ type: "web_search" }],
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
    citations: collectCitations(response.output),
    responseId: response.id,
    model: response.model,
    promptVersion: REPORT_PROMPT_VERSION,
    usage: response.usage,
  };
}
