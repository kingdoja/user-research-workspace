import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { createInterviewProjectSchema } from "@/lib/interview-schema";
import { personaInputSchema } from "@/lib/persona-input-schema";
import { collectPublicWebSources, getPublicWebSearchStatus } from "@/lib/public-web-search";

const productToolNameSchema = z.enum([
  "web.search",
  "web.open",
  "persona.list",
  "persona.create",
  "interview.create",
  "research.create",
  "research.run_confirmed",
  "report.read",
]);

export type UniversalAgentProductToolName = z.infer<typeof productToolNameSchema>;

export type UniversalAgentProductTool = {
  name: UniversalAgentProductToolName;
  title: string;
  description: string;
  mutates: boolean;
  inputHint: string;
};

export type UniversalAgentProductToolResult = {
  status: "ok" | "created" | "queued" | "clarification_required" | "blocked" | "not_found" | "invalid";
  resourceType: "persona_collection" | "persona" | "interview" | "study" | "report" | "product_tool";
  resourcePublicId: string | null;
  href: string | null;
  summary: string;
  nextAction: string | null;
  data?: Record<string, unknown>;
  error?: string;
};

export const UNIVERSAL_AGENT_PRODUCT_TOOLS: readonly UniversalAgentProductTool[] = [
  {
    name: "web.search",
    title: "联网搜索公开网页",
    description: "搜索并抓取公开网页，返回可核查的标题、链接和摘要；只读，不修改工作区数据。",
    mutates: false,
    inputHint: "query, maxResults(1-8)",
  },
  {
    name: "web.open",
    title: "读取公开网页",
    description: "读取用户或 Agent 指定的公开网页，返回清洗后的正文和来源元数据；只读，不绕过登录或付费墙。",
    mutates: false,
    inputHint: "urls(1-8)",
  },
  {
    name: "persona.list",
    title: "查询 AI Persona",
    description: "列出当前工作区可用于访谈的 AI Persona。",
    mutates: false,
    inputHint: '{"limit": 20}',
  },
  {
    name: "persona.create",
    title: "创建 AI Persona",
    description: "创建一个结构化 AI Persona，可供后续访谈项目复用。",
    mutates: true,
    inputHint: "name, archetype, age, city, occupation, commute, budget, currentSituation, goals[], painPoints[], decisionStyle, tags[], visibility, addToPanelPublicIds[]",
  },
  {
    name: "interview.create",
    title: "创建并运行 AI 访谈",
    description: "用已存在的 Persona 创建访谈项目；选择 Persona 时会自动排队生成访谈。",
    mutates: true,
    inputHint: "title, objective, personaPublicIds[], panelPublicId?, studyPublicId?",
  },
  {
    name: "research.create",
    title: "创建研究与报告任务",
    description: "创建研究项目并进入澄清/计划阶段，最终报告由受治理的研究 Harness 生成。",
    mutates: true,
    inputHint: "brief, productLine(research|market_insight), sourcePanelPublicId?",
  },
  {
    name: "research.run_confirmed",
    title: "运行已确认研究",
    description: "仅为已经由用户确认并锁定计划的研究排队执行；不会绕过澄清或计划确认。",
    mutates: true,
    inputHint: "studyPublicId",
  },
  {
    name: "report.read",
    title: "读取研究报告",
    description: "读取当前工作区内研究的状态和已生成报告的核心内容。",
    mutates: false,
    inputHint: "studyPublicId",
  },
] as const;

const productToolSchemas: Record<UniversalAgentProductToolName, z.ZodType<Record<string, unknown>>> = {
  "web.search": z.object({
    query: z.string().trim().min(3).max(500),
    maxResults: z.number().int().min(1).max(8).default(6),
  }).strict(),
  "web.open": z.object({
    urls: z.array(z.string().trim().url().max(2000)).min(1).max(8),
  }).strict(),
  "persona.list": z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict(),
  "persona.create": personaInputSchema.strict(),
  "interview.create": createInterviewProjectSchema.strict(),
  "research.create": z.object({
    brief: z.string().trim().min(12).max(4000),
    productLine: z.enum(["research", "market_insight"]).default("research"),
    sourcePanelPublicId: z.string().trim().min(8).max(120).optional(),
  }).strict(),
  "research.run_confirmed": z.object({ studyPublicId: z.string().trim().min(8).max(120) }).strict(),
  "report.read": z.object({ studyPublicId: z.string().trim().min(8).max(120) }).strict(),
};

export function isUniversalAgentProductToolName(value: string | null): value is UniversalAgentProductToolName {
  return productToolNameSchema.safeParse(value).success;
}

export function formatUniversalAgentProductToolCatalog() {
  return UNIVERSAL_AGENT_PRODUCT_TOOLS.map((tool) => (
    `${tool.name} | ${tool.mutates ? "需要执行确认" : "只读"} | ${tool.description} | 参数：${tool.inputHint}`
  )).join("\n");
}

export async function executeUniversalAgentProductTool(input: {
  viewer: Viewer;
  toolName: UniversalAgentProductToolName;
  arguments: Record<string, unknown>;
  executionAllowed: boolean;
}): Promise<UniversalAgentProductToolResult> {
  const tool = UNIVERSAL_AGENT_PRODUCT_TOOLS.find((candidate) => candidate.name === input.toolName);
  if (!tool) return {
    status: "not_found", resourceType: "product_tool", resourcePublicId: null, href: null,
    summary: `产品工具 ${input.toolName} 不存在。`, nextAction: null, error: "product_tool_not_found",
  };
  if (tool.mutates && !input.executionAllowed) {
    return {
      status: "blocked", resourceType: "product_tool", resourcePublicId: null, href: null,
      summary: `未执行 ${input.toolName}：本轮未获得副作用执行确认。`,
      nextAction: "请用户确认本轮允许执行已选能力。", error: "product_execution_not_confirmed",
    };
  }
  const parsed = productToolSchemas[input.toolName].safeParse(input.arguments);
  if (!parsed.success) {
    return {
      status: "invalid", resourceType: "product_tool", resourcePublicId: null, href: null,
      summary: `${input.toolName} 的输入未通过校验。`, nextAction: "根据 issues 修正参数后重试。",
      error: "product_tool_input_invalid",
      data: { toolName: input.toolName, issues: parsed.error.issues.slice(0, 8).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })) },
    };
  }

  if (input.toolName === "web.search") {
    const args = parsed.data as { query: string; maxResults: number };
    const result = await collectPublicWebSources([args.query], []);
    const sources = result.sources.slice(0, args.maxResults).map((source) => ({
      sourceId: source.observationPublicId ?? source.snapshotPublicId ?? source.url,
      title: source.title,
      url: source.url,
      excerpt: source.excerpt.slice(0, 1200),
      contentHash: source.contentHash ?? null,
      collectedAt: source.collectedAt ?? null,
    }));
    const provider = getPublicWebSearchStatus();
    if (!sources.length) {
      return {
        status: "ok", resourceType: "product_tool", resourcePublicId: null, href: null,
        summary: `未找到可核查的公开网页（${provider.primaryProvider} 搜索无结果或来源抓取失败）。`,
        nextAction: "尝试更具体的关键词，或提供一个公开网页链接。",
        data: { query: args.query, sources: [], metadata: result.metadata },
      };
    }
    return {
      status: "ok", resourceType: "product_tool", resourcePublicId: null, href: null,
      summary: `已搜索“${args.query}”，找到 ${sources.length} 条可核查公开来源。`,
      nextAction: null,
      data: { query: args.query, sources, metadata: result.metadata },
    };
  }

  if (input.toolName === "web.open") {
    const args = parsed.data as { urls: string[] };
    const result = await collectPublicWebSources([], args.urls);
    const sources = result.sources.map((source) => ({
      sourceId: source.observationPublicId ?? source.snapshotPublicId ?? source.url,
      title: source.title,
      url: source.url,
      excerpt: source.excerpt.slice(0, 5000),
      contentHash: source.contentHash ?? null,
      collectedAt: source.collectedAt ?? null,
    }));
    return {
      status: "ok", resourceType: "product_tool", resourcePublicId: null, href: null,
      summary: sources.length
        ? `已读取 ${sources.length} 个公开网页，返回清洗后的正文证据。`
        : "指定网页未返回可核查正文（可能被 robots、访问限制或页面类型策略拒绝）。",
      nextAction: sources.length ? null : "检查链接是否公开可访问，或提供其他来源。",
      data: { urls: args.urls, sources, metadata: result.metadata },
    };
  }

  if (input.toolName === "persona.list") {
    const { listPersonas } = await import("@/lib/studies");
    const args = parsed.data as { limit: number };
    const library = await listPersonas(input.viewer);
    return {
      status: "ok", resourceType: "persona_collection", resourcePublicId: null, href: "/persona",
      summary: `已读取 ${Math.min(library.personas.length, args.limit)} 个 Persona，工作区共 ${library.personas.length} 个。`,
      nextAction: null,
      data: { personas: library.personas.slice(0, args.limit).map((persona) => ({
        publicId: persona.publicId,
        name: persona.name,
        archetype: persona.archetype,
        occupation: persona.profile.occupation,
        city: persona.profile.city,
        tags: persona.profile.tags,
      })), total: library.personas.length },
    };
  }
  if (input.toolName === "persona.create") {
    const { createPersona } = await import("@/lib/studies");
    const publicId = await createPersona(input.viewer, parsed.data as z.infer<typeof personaInputSchema>);
    return {
      status: "created", resourceType: "persona", resourcePublicId: publicId,
      href: `/persona?persona=${encodeURIComponent(publicId)}`, summary: `已创建 Persona ${publicId}。`, nextAction: null,
    };
  }
  if (input.toolName === "interview.create") {
    const { createInterviewProject } = await import("@/lib/interviews");
    const result = await createInterviewProject(input.viewer, parsed.data as z.infer<typeof createInterviewProjectSchema>);
    return {
      status: result.queued ? "queued" : "created",
      resourceType: "interview", resourcePublicId: result.publicId,
      href: `/interview/projects/${encodeURIComponent(result.publicId)}`,
      summary: result.queued ? `已创建访谈 ${result.publicId} 并排队执行。` : `已创建访谈 ${result.publicId}。`,
      nextAction: null,
    };
  }
  if (input.toolName === "research.create") {
    const { createStudy } = await import("@/lib/studies");
    const args = parsed.data as { brief: string; productLine: "research" | "market_insight"; sourcePanelPublicId?: string };
    const publicId = await createStudy(input.viewer, args.brief, args.productLine, args.sourcePanelPublicId);
    return {
      status: "clarification_required",
      resourceType: "study", resourcePublicId: publicId,
      href: `/study/${encodeURIComponent(publicId)}`,
      summary: `已创建研究 ${publicId}，当前需要澄清和计划确认。`,
      nextAction: "请在研究页面完成澄清并确认计划；确认后可调用 research.run_confirmed。",
    };
  }
  if (input.toolName === "research.run_confirmed") {
    const [{ queueStudyRun }, { enqueueLatestStudyRun }] = await Promise.all([
      import("@/lib/studies"),
      import("@/lib/research-harness"),
    ]);
    const { studyPublicId } = parsed.data as { studyPublicId: string };
    const status = await queueStudyRun(input.viewer, studyPublicId);
    if (status === "queued") await enqueueLatestStudyRun(studyPublicId, input.viewer.workspaceId);
    const state = {
      queued: {
        status: "queued" as const,
        summary: `研究 ${studyPublicId} 已排队执行。`,
        nextAction: null,
        error: undefined,
      },
      already_running: {
        status: "ok" as const,
        summary: `研究 ${studyPublicId} 已在执行或排队中，未重复创建任务。`,
        nextAction: "等待当前研究运行完成。",
        error: undefined,
      },
      completed: {
        status: "ok" as const,
        summary: `研究 ${studyPublicId} 已完成。`,
        nextAction: "调用 report.read 读取报告。",
        error: undefined,
      },
      waiting_input: {
        status: "blocked" as const,
        summary: `研究 ${studyPublicId} 正在等待用户补充输入。`,
        nextAction: "请用户在研究页完成待补充任务。",
        error: "research_waiting_input",
      },
      plan_not_confirmed: {
        status: "blocked" as const,
        summary: `研究 ${studyPublicId} 未执行：计划尚未由用户确认。`,
        nextAction: "请用户在研究页确认并锁定计划后重试。",
        error: "research_plan_not_confirmed",
      },
      provider_missing: {
        status: "blocked" as const,
        summary: `研究 ${studyPublicId} 未执行：研究模型 Provider 尚未配置。`,
        nextAction: "配置研究阶段 Provider 后重试。",
        error: "research_provider_missing",
      },
      not_found: {
        status: "not_found" as const,
        summary: `当前工作区中不存在研究 ${studyPublicId}。`,
        nextAction: null,
        error: "study_not_found",
      },
    }[status];
    return {
      status: state.status,
      resourceType: "study", resourcePublicId: studyPublicId,
      href: status === "not_found" ? null : `/study/${encodeURIComponent(studyPublicId)}`,
      summary: state.summary,
      nextAction: state.nextAction,
      data: { queueStatus: status },
      error: state.error,
    };
  }

  const { studyPublicId } = parsed.data as { studyPublicId: string };
  const { getStudy } = await import("@/lib/studies");
  const study = await getStudy(input.viewer, studyPublicId);
  if (!study) return {
    status: "not_found", resourceType: "study", resourcePublicId: studyPublicId, href: null,
    summary: `当前工作区中不存在研究 ${studyPublicId}。`, nextAction: null, error: "study_not_found",
  };
  return {
    status: "ok", resourceType: study.report ? "report" : "study",
    resourcePublicId: study.report?.publicId ?? studyPublicId,
    href: `/study/${encodeURIComponent(studyPublicId)}`,
    summary: study.report ? `已读取研究“${study.title}”的报告。` : `研究“${study.title}”尚未生成报告。`,
    nextAction: study.report ? null : "等待研究运行完成后重试 report.read。",
    data: { studyPublicId, title: study.title, studyStatus: study.status, runStatus: study.runStatus, report: study.report ? {
      publicId: study.report.publicId,
      title: study.report.title,
      generatedAt: study.report.generatedAt,
      content: study.report.content,
    } : null },
  };
}
