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
