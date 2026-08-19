import type { ProviderResearchDiscussion, SyntheticPanelResearch } from "@/lib/openai-provider";
import type { PublicWebSource } from "@/lib/public-web-search";

export type ReportEvidenceType = "fact" | "human_observation" | "synthetic_simulation" | "model_inference" | "calculation";
export type ReportSourceType = "public_web" | "context_asset" | "interview_session" | "synthetic_interview" | "discussion" | "calculation" | "user_input";

export type ReportEvidenceCatalogItem = {
  ref: string;
  title: string;
  sourceType: ReportSourceType;
  evidenceType: ReportEvidenceType;
  content: string;
  sourceUri: string | null;
  locator: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export function getClaimSupportStatus(
  claimType: "fact" | "human_observation" | "synthetic_simulation" | "model_inference",
  evidence: ReportEvidenceCatalogItem[],
) {
  if (!evidence.length) return "unsupported" as const;
  if (claimType === "fact" && evidence.every((item) => item.evidenceType === "fact" || item.evidenceType === "calculation")) {
    return "supported" as const;
  }
  if (claimType === "human_observation" && evidence.every((item) => item.evidenceType === "human_observation")) {
    return "supported" as const;
  }
  return "mixed" as const;
}

const INFERENCE_LANGUAGE = /适合|建议|可以|可将|可作为|应当|应该|策略|方案|机会|优先|实验框架|值得测试/u;
const INTERNAL_REPORT_TERMS: Array<[string, string]> = [
  ["behavioralEvidenceCount", "行为证据数量"],
  ["attitudinalEvidenceCount", "态度证据数量"],
  ["platformSourceCount", "平台来源数量"],
  ["usableSourceCount", "可用来源数量"],
  ["answerability.level", "可回答性等级"],
  ["answerability", "证据可回答性"],
  ["claimType", "结论类型"],
  ["confidence", "置信度"],
  ["evidenceRefs", "证据引用"],
];

export function hasInferentialLanguage(text: string) {
  return INFERENCE_LANGUAGE.test(text);
}

export function toReaderFacingEvidenceText(text: string, catalog: ReportEvidenceCatalogItem[]) {
  let value = text;
  for (const item of catalog) value = value.replaceAll(item.ref, `《${item.title}》`);
  for (const [internal, label] of INTERNAL_REPORT_TERMS) value = value.replaceAll(internal, label);
  return value;
}

function cleanParts(parts: Array<string | null | undefined>) {
  return parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)).join("\n");
}

export function buildReportEvidenceCatalog(input: {
  sources: PublicWebSource[];
  panelResearch?: SyntheticPanelResearch;
  discussion?: ProviderResearchDiscussion;
}): ReportEvidenceCatalogItem[] {
  const web = input.sources.map((source, index) => ({
    ref: `web-${String(index + 1).padStart(2, "0")}`,
    title: source.title,
    sourceType: "public_web" as const,
    evidenceType: "fact" as const,
    content: source.excerpt,
    sourceUri: source.url,
    locator: {
      url: source.url,
      snapshotPublicId: source.snapshotPublicId,
      observationPublicId: source.observationPublicId,
    },
    metadata: {
      ordinal: index + 1,
      connectorRunPublicId: source.connectorRunPublicId,
      candidatePublicId: source.candidatePublicId,
      snapshotPublicId: source.snapshotPublicId,
      observationPublicId: source.observationPublicId,
      contentHash: source.contentHash,
      collectedAt: source.collectedAt,
    },
  }));
  const synthetic = (input.panelResearch?.interviews ?? []).map((interview, index) => ({
    ref: `synthetic-${String(index + 1).padStart(2, "0")}`,
    title: `AI 合成访谈 · ${interview.personaName} · 第 ${interview.batch} 批`,
    sourceType: "synthetic_interview" as const,
    evidenceType: "synthetic_simulation" as const,
    content: cleanParts([
      interview.summary,
      ...interview.insights.map((insight) => `洞察：${insight}`),
      ...interview.quotes.map((quote) => `合成表达：${quote}`),
    ]),
    sourceUri: null,
    locator: { personaName: interview.personaName, batch: interview.batch, objective: interview.objective },
    metadata: { disclaimer: "AI 合成 Persona 模拟，不是真人陈述，也不具备统计代表性。" },
  }));
  const discussion = input.discussion ? [{
    ref: "discussion-01",
    title: input.discussion.title,
    sourceType: "discussion" as const,
    evidenceType: "synthetic_simulation" as const,
    content: cleanParts([
      input.discussion.topic,
      ...input.discussion.findings.map((finding) => `发现：${finding}`),
      ...input.discussion.consensus.map((item) => `共识：${item}`),
      ...input.discussion.disagreements.map((item) => `分歧：${item}`),
    ]),
    sourceUri: null,
    locator: { timelineToken: input.discussion.timelineToken },
    metadata: { disclaimer: input.discussion.disclaimer },
  }] : [];
  return [...web, ...synthetic, ...discussion];
}

export function formatReportEvidenceCatalog(catalog: ReportEvidenceCatalogItem[]) {
  return catalog.map((item) => [
    `[${item.ref}] ${item.title}`,
    `证据类型：${item.evidenceType}`,
    item.sourceUri ? `URL：${item.sourceUri}` : null,
    item.content,
  ].filter(Boolean).join("\n")).join("\n\n");
}
