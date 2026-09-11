import * as cheerio from "cheerio";
import {
  buildSourceConnectorAudit,
  canonicalizeSourceUrl,
  collectSourceCandidate,
  type CollectedSourceCandidate,
  type SourceCandidate,
  type SourceConnectorAudit,
} from "@/lib/source-connectors";
import { createPublicId } from "@/lib/identifiers";

export type PublicWebSource = {
  title: string;
  url: string;
  excerpt: string;
  connectorRunPublicId?: string;
  candidatePublicId?: string;
  snapshotPublicId?: string;
  observationPublicId?: string;
  contentHash?: string;
  collectedAt?: string;
};

export type PublicWebSearchMetadata = {
  primaryProvider: "tavily" | "bing" | "gpt-researcher";
  fallbackUsed: boolean;
  queryPlanFallbackUsed?: boolean;
  autonomousExpansionUsed?: boolean;
  autonomousRecoveryQueryCount?: number;
  rawStorageFallbackUsed?: boolean;
  rawStorageFallbackReasons?: string[];
  seedSourceCount: number;
  searchSourceCount: number;
  finalSourceCount: number;
  candidateCount?: number;
  rejectedCount?: number;
  unavailableCount?: number;
  connectorRunPublicId?: string;
  policyVersion?: string;
  socialConnectorEnabled?: boolean;
  socialRequestedPlatform?: string | null;
  socialCollectionMode?: "official_public_api" | "public_web_plus_official_api" | "public_web_search_only";
  socialSourceCount?: number;
  socialCandidateCount?: number;
  socialConnectorRunPublicId?: string;
  researchEngine?: "local" | "gpt-researcher";
  researchEngineFallbackUsed?: boolean;
  researchEngineFallbackReason?: string;
  qualityRejectedCount?: number;
  qualityRejectionReasons?: Record<string, number>;
  sourceStrategyVersion?: string;
  evidenceNeeds?: string[];
  preferredSourceModes?: string[];
  fallbackSourceModes?: string[];
  requestedPlatforms?: string[];
};

export type PublicWebCollectionResult = {
  sources: PublicWebSource[];
  metadata: PublicWebSearchMetadata;
  audit: SourceConnectorAudit;
};

const SEARCH_RESULT_LIMIT = 12;
const CANDIDATE_LIMIT = 28;

export function getPublicWebSearchStatus() {
  const tavilyConfigured = Boolean(process.env.TAVILY_API_KEY?.trim());
  return {
    tavilyConfigured,
    primaryProvider: tavilyConfigured ? "tavily" : "bing",
    fallbackProvider: "bing",
  } as const;
}

function candidate(input: Omit<SourceCandidate, "publicId">): SourceCandidate {
  return { ...input, publicId: createPublicId("src") };
}

async function searchBing(query: string, signal?: AbortSignal) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("setlang", "zh-hans");
  const response = await fetch(url, {
    credentials: "omit",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: {
      "user-agent": "atypica-research/1.0 (+public-source-audit)",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    },
  });
  if (!response.ok) throw new Error(`SEARCH_HTTP_${response.status}`);
  const $ = cheerio.load(await response.text());
  const results: SourceCandidate[] = [];
  $("li.b_algo").each((index, element) => {
    const link = $(element).find("h2 a").first();
    const title = link.text().replace(/\s+/g, " ").trim();
    const href = link.attr("href");
    const providerExcerpt = $(element).find(".b_caption p").first().text().replace(/\s+/g, " ").trim();
    if (!title || !href) return;
    try {
      const parsedUrl = new URL(href);
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return;
    } catch {
      return;
    }
    results.push(candidate({ provider: "bing", query, rank: index + 1, score: null, title, url: href, providerExcerpt }));
  });
  return results.slice(0, 6);
}

async function searchTavily(query: string, apiKey: string, signal?: AbortSignal) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    credentials: "omit",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query, search_depth: "advanced", max_results: 6, include_answer: false, include_raw_content: false }),
  });
  if (!response.ok) throw new Error(`TAVILY_HTTP_${response.status}`);
  const payload = await response.json() as {
    results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
  };
  return (payload.results ?? []).flatMap((result, index) => {
    const title = result.title?.replace(/\s+/g, " ").trim();
    const url = result.url?.trim();
    if (!title || !url) return [];
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return [];
    } catch {
      return [];
    }
    return [candidate({
      provider: "tavily",
      query,
      rank: index + 1,
      score: typeof result.score === "number" ? result.score : null,
      title,
      url,
      providerExcerpt: result.content?.replace(/\s+/g, " ").trim().slice(0, 1200),
    })];
  });
}

function deduplicateCandidates(groups: SourceCandidate[][]) {
  const unique = new Map<string, SourceCandidate>();
  for (const item of groups.flat()) {
    let key: string;
    try { key = canonicalizeSourceUrl(item.url); } catch { key = item.url; }
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].slice(0, CANDIDATE_LIMIT);
}

async function collectCandidates(candidates: SourceCandidate[], signal?: AbortSignal) {
  return Promise.all(candidates.map((item) => collectSourceCandidate(item, { signal })));
}

function deduplicateCollectedContent(candidates: CollectedSourceCandidate[]) {
  const hashes = new Map<string, CollectedSourceCandidate>();
  const unique: CollectedSourceCandidate[] = [];
  for (const item of candidates) {
    if (item.status !== "collected" || !item.snapshot?.contentHash || !item.observation) continue;
    const duplicate = hashes.get(item.snapshot.contentHash);
    if (duplicate) {
      item.metadata = { ...item.metadata, duplicateOfCandidatePublicId: duplicate.publicId };
      continue;
    }
    hashes.set(item.snapshot.contentHash, item);
    unique.push(item);
  }
  return unique.slice(0, SEARCH_RESULT_LIMIT);
}

function publicSources(candidates: CollectedSourceCandidate[], connectorRunPublicId: string) {
  return deduplicateCollectedContent(candidates).map((item) => ({
    title: item.resolvedTitle,
    url: item.canonicalUrl,
    excerpt: item.observation!.content,
    connectorRunPublicId,
    candidatePublicId: item.publicId,
    snapshotPublicId: item.snapshot!.publicId,
    observationPublicId: item.observation!.publicId,
    contentHash: item.snapshot!.contentHash!,
    collectedAt: item.snapshot!.fetchedAt,
  } satisfies PublicWebSource));
}

export async function collectPublicWebSources(queries: string[], seedUrls: string[], signal?: AbortSignal): Promise<PublicWebCollectionResult> {
  const startedAt = new Date().toISOString();
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim();
  const primaryProvider = tavilyApiKey ? "tavily" : "bing";
  const seedCandidates = seedUrls.slice(0, 16).flatMap((url, index) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
      return [candidate({ provider: "seed", query: null, rank: index + 1, score: null, title: parsed.hostname, url })];
    } catch {
      return [];
    }
  });
  const providerErrors: string[] = [];
  let fallbackUsed = false;
  let allCandidates = seedCandidates;
  let collected: CollectedSourceCandidate[] = [];

  if (tavilyApiKey) {
    const tavilyGroups = await Promise.all(queries.map(async (query) => {
      try { return await searchTavily(query, tavilyApiKey, signal); }
      catch (error) { providerErrors.push(error instanceof Error ? error.message : "TAVILY_SEARCH_FAILED"); return []; }
    }));
    allCandidates = deduplicateCandidates([seedCandidates, ...tavilyGroups]);
    collected = await collectCandidates(allCandidates, signal);
  } else {
    collected = await collectCandidates(seedCandidates, signal);
  }

  if (deduplicateCollectedContent(collected).length < 6) {
    fallbackUsed = Boolean(tavilyApiKey);
    const bingGroups = await Promise.all(queries.map(async (query) => {
      try { return await searchBing(query, signal); }
      catch (error) { providerErrors.push(error instanceof Error ? error.message : "BING_SEARCH_FAILED"); return []; }
    }));
    const nextCandidates = deduplicateCandidates([allCandidates, ...bingGroups]);
    const existing = new Set(allCandidates.map((item) => {
      try { return canonicalizeSourceUrl(item.url); } catch { return item.url; }
    }));
    const newCandidates = nextCandidates.filter((item) => {
      try { return !existing.has(canonicalizeSourceUrl(item.url)); } catch { return !existing.has(item.url); }
    });
    collected = [...collected, ...await collectCandidates(newCandidates, signal)];
    allCandidates = [...allCandidates, ...newCandidates];
  }

  const audit = buildSourceConnectorAudit({
    provider: primaryProvider,
    queries,
    startedAt,
    candidates: collected,
    metadata: { fallbackUsed, providerErrors: [...new Set(providerErrors)].slice(0, 12) },
  });
  const sources = publicSources(collected, audit.publicId);
  return {
    sources,
    audit,
    metadata: {
      primaryProvider,
      fallbackUsed,
      seedSourceCount: sources.filter((source) => collected.find((item) => item.publicId === source.candidatePublicId)?.provider === "seed").length,
      searchSourceCount: sources.filter((source) => collected.find((item) => item.publicId === source.candidatePublicId)?.provider !== "seed").length,
      finalSourceCount: sources.length,
      candidateCount: audit.candidateCount,
      rejectedCount: audit.rejectedCount,
      unavailableCount: audit.unavailableCount,
      connectorRunPublicId: audit.publicId,
      policyVersion: audit.policyVersion,
    },
  };
}
