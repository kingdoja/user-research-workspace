import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { createInterviewProjectSchema } from "@/lib/interview-schema";
import { personaInputSchema } from "@/lib/persona-input-schema";

const productToolNameSchema = z.enum([
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

export const UNIVERSAL_AGENT_PRODUCT_TOOLS: readonly UniversalAgentProductTool[] = [
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
}) {
  const tool = UNIVERSAL_AGENT_PRODUCT_TOOLS.find((candidate) => candidate.name === input.toolName);
  if (!tool) return { error: "product_tool_not_found", toolName: input.toolName };
  if (tool.mutates && !input.executionAllowed) {
    return { error: "product_execution_not_confirmed", toolName: input.toolName };
  }
  const parsed = productToolSchemas[input.toolName].safeParse(input.arguments);
  if (!parsed.success) {
    return {
      error: "product_tool_input_invalid",
      toolName: input.toolName,
      issues: parsed.error.issues.slice(0, 8).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  if (input.toolName === "persona.list") {
    const { listPersonas } = await import("@/lib/studies");
    const args = parsed.data as { limit: number };
    const library = await listPersonas(input.viewer);
    return {
      personas: library.personas.slice(0, args.limit).map((persona) => ({
        publicId: persona.publicId,
        name: persona.name,
        archetype: persona.archetype,
        occupation: persona.profile.occupation,
        city: persona.profile.city,
        tags: persona.profile.tags,
      })),
      total: library.personas.length,
    };
  }
  if (input.toolName === "persona.create") {
    const { createPersona } = await import("@/lib/studies");
    const publicId = await createPersona(input.viewer, parsed.data as z.infer<typeof personaInputSchema>);
    return { status: "created", publicId, href: `/persona?persona=${encodeURIComponent(publicId)}` };
  }
  if (input.toolName === "interview.create") {
    const { createInterviewProject } = await import("@/lib/interviews");
    const result = await createInterviewProject(input.viewer, parsed.data as z.infer<typeof createInterviewProjectSchema>);
    return {
      status: result.queued ? "queued" : "created",
      publicId: result.publicId,
      href: `/interview/projects/${encodeURIComponent(result.publicId)}`,
    };
  }
  if (input.toolName === "research.create") {
    const { createStudy } = await import("@/lib/studies");
    const args = parsed.data as { brief: string; productLine: "research" | "market_insight"; sourcePanelPublicId?: string };
    const publicId = await createStudy(input.viewer, args.brief, args.productLine, args.sourcePanelPublicId);
    return {
      status: "clarification_required",
      publicId,
      href: `/study/${encodeURIComponent(publicId)}`,
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
    return {
      status,
      studyPublicId,
      href: `/study/${encodeURIComponent(studyPublicId)}`,
      note: status === "plan_not_confirmed" ? "研究计划尚未由用户确认，Agent 不会绕过该门槛。" : undefined,
    };
  }

  const { studyPublicId } = parsed.data as { studyPublicId: string };
  const { getStudy } = await import("@/lib/studies");
  const study = await getStudy(input.viewer, studyPublicId);
  if (!study) return { error: "study_not_found", studyPublicId };
  return {
    studyPublicId,
    title: study.title,
    status: study.status,
    runStatus: study.runStatus,
    href: `/study/${encodeURIComponent(studyPublicId)}`,
    report: study.report ? {
      publicId: study.report.publicId,
      title: study.report.title,
      generatedAt: study.report.generatedAt,
      content: study.report.content,
    } : null,
  };
}
