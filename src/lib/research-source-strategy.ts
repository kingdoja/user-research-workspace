import type { StudyMethod } from "@/lib/research-types";
import { classifyResearchQuestionTypes } from "@/lib/research-report-design";
import { listResearchSourceConnectors, type ResearchConnectorRegistration } from "@/lib/research-source-connectors";

export const RESEARCH_SOURCE_STRATEGY_VERSION = "research-source-strategy-v1";

export type EvidenceNeed =
  | "market_facts"
  | "first_person_voice"
  | "behavior_metrics"
  | "official_platform_data"
  | "competitor_comparison"
  | "primary_research";

export type ResearchSourceMode = "public_web" | "official_api" | "workspace_context" | "human_input";

export type ResearchSourceStrategy = {
  version: string;
  evidenceNeeds: EvidenceNeed[];
  requestedPlatforms: string[];
  preferredModes: ResearchSourceMode[];
  fallbackModes: ResearchSourceMode[];
  rationale: string[];
  connectors: ResearchConnectorRegistration[];
};

const PLATFORM_ALIASES = [
  { label: "小红书", patterns: ["小红书", "xiaohongshu", "rednote"] },
  { label: "抖音", patterns: ["抖音", "douyin"] },
  { label: "微博", patterns: ["微博", "weibo"] },
  { label: "B站", patterns: ["b站", "哔哩哔哩", "bilibili"] },
  { label: "知乎", patterns: ["知乎", "zhihu"] },
  { label: "Bluesky", patterns: ["bluesky"] },
] as const;

export function detectRequestedResearchPlatforms(brief?: string) {
  const normalized = (brief ?? "").toLowerCase();
  return PLATFORM_ALIASES
    .filter(({ patterns }) => patterns.some((pattern) => normalized.includes(pattern)))
    .map(({ label }) => label);
}

export function deriveEvidenceNeeds(input: { brief?: string; methods?: StudyMethod[] }): EvidenceNeed[] {
  const brief = input.brief ?? "";
  const methods = input.methods ?? [];
  const questionTypes = classifyResearchQuestionTypes(brief);
  const needs = new Set<EvidenceNeed>(["market_facts"]);

  if (questionTypes.includes("attitudinal") || /用户|消费者|体验|痛点|偏好|动机|评价|反馈/u.test(brief)) {
    needs.add("first_person_voice");
  }
  if (questionTypes.includes("behavioral") || /收藏|分享|转发|点赞|播放|点击|转化|留存|复购|互动率/u.test(brief)) {
    needs.add("behavior_metrics");
  }
  if (questionTypes.includes("comparative") || /竞品|对比|比较|替代|品牌/u.test(brief)) {
    needs.add("competitor_comparison");
  }
  if (methods.includes("Interview Chat") || methods.includes("Discussion Chat")) {
    needs.add("primary_research");
  }
  if (detectRequestedResearchPlatforms(brief).length || methods.includes("Scout Agent")) {
    needs.add("official_platform_data");
  }
  return [...needs];
}

export function planResearchSources(input: { brief?: string; methods?: StudyMethod[] }): ResearchSourceStrategy {
  const requestedPlatforms = detectRequestedResearchPlatforms(input.brief);
  const evidenceNeeds = deriveEvidenceNeeds(input);
  const connectors = listResearchSourceConnectors();
  const preferredModes: ResearchSourceMode[] = ["public_web"];
  const fallbackModes: ResearchSourceMode[] = ["workspace_context", "human_input"];
  const rationale = ["公开网页搜索是默认入口，先建立可核查的事实和背景基线。"];

  if (evidenceNeeds.includes("official_platform_data")) {
    preferredModes.push("official_api");
    rationale.push(requestedPlatforms.length
      ? `问题提及${requestedPlatforms.join("、")}，按连接器可用性尝试官方 API；不可用时回退到被搜索引擎收录的公开页面。`
      : "研究方法包含社交信号扫描，按连接器可用性尝试官方 API；不可用时回退到公开网页。");
  }
  if (evidenceNeeds.includes("behavior_metrics")) {
    rationale.push("行为指标需要平台返回的互动字段或用户提供的行为数据，网页摘要不能替代行为证据。");
  }
  if (evidenceNeeds.includes("first_person_voice")) {
    rationale.push("态度和动机优先寻找第一人称表达；证据不足时降低结论强度并请求访谈、问卷或评论语料。 ");
  }
  if (evidenceNeeds.includes("primary_research")) {
    preferredModes.push("human_input");
    rationale.push("访谈或讨论结果作为一手研究材料，与公开资料分层呈现。");
  }

  return {
    version: RESEARCH_SOURCE_STRATEGY_VERSION,
    evidenceNeeds,
    requestedPlatforms,
    preferredModes: [...new Set(preferredModes)],
    fallbackModes,
    rationale,
    connectors,
  };
}
