import { z } from "zod";

export const RESEARCH_AGENT_TASK_TEMPLATE_VERSION = "research-agent-task-templates-v1";

const resumeInputSchema = z.object({
  focus: z.string().max(600).optional(),
  sourceUrls: z.array(z.string().url()).max(8).optional(),
  selectedOption: z.string().max(160).optional(),
}).strict();

const targetedResearchInputSchema = z.object({
  platform: z.string().min(1).max(160).optional(),
  focus: z.string().max(600).optional(),
  resumeInput: resumeInputSchema.optional(),
}).strict();

const socialSignalScanInputSchema = z.object({
  platform: z.string().min(1).max(160),
  focus: z.string().max(600).optional(),
  resumeInput: resumeInputSchema.optional(),
}).strict();

export type ResearchAgentTaskTemplateName = "targeted_research" | "social_signal_scan";

export type ResearchAgentTaskTemplate = {
  name: ResearchAgentTaskTemplateName;
  version: string;
  toolName: "deepResearch" | "scoutSocialTrends";
  description: string;
  inputSchema: z.ZodType<Record<string, unknown>>;
};

const templates: Record<ResearchAgentTaskTemplateName, ResearchAgentTaskTemplate> = {
  targeted_research: {
    name: "targeted_research",
    version: RESEARCH_AGENT_TASK_TEMPLATE_VERSION,
    toolName: "deepResearch",
    description: "针对明确证据缺口追加公开资料研究。",
    inputSchema: targetedResearchInputSchema as z.ZodType<Record<string, unknown>>,
  },
  social_signal_scan: {
    name: "social_signal_scan",
    version: RESEARCH_AGENT_TASK_TEMPLATE_VERSION,
    toolName: "scoutSocialTrends",
    description: "针对指定社交平台追加趋势与用户表达扫描。",
    inputSchema: socialSignalScanInputSchema as z.ZodType<Record<string, unknown>>,
  },
};

export function listResearchAgentTaskTemplates(): ResearchAgentTaskTemplate[] {
  return Object.values(templates);
}

export function getResearchAgentTaskTemplate(name: string | null | undefined) {
  return name && name in templates ? templates[name as ResearchAgentTaskTemplateName] : null;
}

export function inferResearchAgentTaskTemplate(toolName: string): ResearchAgentTaskTemplateName | null {
  if (toolName === "deepResearch") return "targeted_research";
  if (toolName === "scoutSocialTrends") return "social_signal_scan";
  return null;
}

export function getAllowedResearchAgentTaskTemplates(config?: Record<string, unknown>): ResearchAgentTaskTemplateName[] {
  const configured = config?.agentControllerAllowedTemplates;
  if (!Array.isArray(configured)) return ["targeted_research", "social_signal_scan"];
  return [...new Set(configured.filter((value): value is ResearchAgentTaskTemplateName => (
    typeof value === "string" && getResearchAgentTaskTemplate(value) !== null
  )))];
}

export function validateResearchAgentTaskTemplate(input: {
  template: string | null | undefined;
  toolName: string;
  taskInput: Record<string, unknown>;
  allowedTemplates?: readonly string[];
}) {
  const inferred = input.template ?? inferResearchAgentTaskTemplate(input.toolName);
  const template = getResearchAgentTaskTemplate(inferred);
  if (!template) return { accepted: false as const, reason: "template_unknown", template: null };
  if (input.allowedTemplates && !input.allowedTemplates.includes(template.name)) {
    return { accepted: false as const, reason: "template_not_allowed", template };
  }
  if (template.toolName !== input.toolName) {
    return { accepted: false as const, reason: "template_tool_mismatch", template };
  }
  const parsed = template.inputSchema.safeParse(input.taskInput);
  if (!parsed.success) return { accepted: false as const, reason: "template_input_invalid", template };
  return { accepted: true as const, reason: null, template, input: parsed.data };
}
