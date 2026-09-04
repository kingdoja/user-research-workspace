export const GPT_RESEARCHER_REPORT_TYPES = ["research_report", "deep", "detailed_report", "subtopic_report"] as const;
export type GptResearcherReportType = typeof GPT_RESEARCHER_REPORT_TYPES[number];

export const GPT_RESEARCHER_REPORT_TYPE_LABELS: Record<GptResearcherReportType, string> = {
  research_report: "Research Report（标准）",
  deep: "Deep Research（深度）",
  detailed_report: "Detailed Report（详细）",
  subtopic_report: "Subtopic Report（子主题）",
};

export function isGptResearcherReportType(value: unknown): value is GptResearcherReportType {
  return typeof value === "string" && (GPT_RESEARCHER_REPORT_TYPES as readonly string[]).includes(value);
}

export function normalizeGptResearcherReportType(value: unknown): GptResearcherReportType {
  return isGptResearcherReportType(value) ? value : "research_report";
}
