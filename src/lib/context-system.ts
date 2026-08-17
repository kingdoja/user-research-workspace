import { createHash } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export type ContextScope = "user" | "workspace" | "study" | "system";
export type ContextReviewStatus = "pending" | "approved" | "rejected";
export type ContextEvidenceKind = "human" | "synthetic" | "mixed" | "not_applicable";
export type ContextPurpose = "general" | "intent_planning" | "research_execution" | "realtime_interview" | "report_generation" | "skill_execution";
export type ContextMemoryKind = "core" | "working" | "team";

export type ContextPolicyDecision = {
  version: "memory-policy-v1";
  purpose: ContextPurpose;
  evaluatedMemoryChunks: number;
  allowedMemoryChunks: number;
  deniedMemoryChunks: number;
  denialReasons: Record<string, number>;
  policyVersions: Record<ContextMemoryKind, number | null>;
};

export type ContextCitation = {
  chunkPublicId: string;
  assetPublicId: string;
  assetVersionPublicId: string;
  assetType: string;
  scope: ContextScope;
  title: string;
  sourceUri: string | null;
  version: number;
  content: string;
  score: number;
  reasons: string[];
  memoryKind: ContextMemoryKind | null;
};

export type ContextSnapshot = {
  retrievalId: string | null;
  retrievalPublicId: string | null;
  retrievedAt: string | null;
  strategy: "lexical_metadata_v1" | "hybrid_v1";
  query: string;
  purpose: ContextPurpose;
  policyVersion: "memory-policy-v1";
  policyDecision: ContextPolicyDecision;
  citations: ContextCitation[];
};

export const CONTEXT_EMBEDDING_BASELINE = {
  model: "hash-ngram-128",
  version: "v1",
  dimensions: 128,
} as const;

export const CONTEXT_PRODUCTION_EMBEDDING_GATE = {
  minimumCaseCount: 20,
  minimumMeanReciprocalRankGain: 0.03,
  requireNonDecreasingPrecisionAtK: true,
  requireNonDecreasingRecallAtK: true,
} as const;

export const contextEmbeddingEvaluationInputSchema = z.object({
  provider: z.enum(["baseline", "openai"]).default("baseline"),
  model: z.string().trim().min(2).max(160).optional(),
});

type ContextEmbeddingEvaluationTarget = {
  provider: "baseline" | "openai";
  providerName: string;
  model: string;
  version: string;
};

type ContextEmbeddingApiStyle = "openai" | "volcengine_multimodal";

type ContextEvaluationMetrics = {
  precisionAtK: number;
  recallAtK: number;
  meanReciprocalRank: number;
};

let contextEmbeddingClient: OpenAI | null = null;

const volcengineMultimodalEmbeddingResponseSchema = z.object({
  data: z.union([
    z.object({ embedding: z.array(z.number()) }).passthrough(),
    z.array(z.object({ embedding: z.array(z.number()) }).passthrough()).min(1),
  ]),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

const contextPurposeSchema = z.enum(["general", "intent_planning", "research_execution", "realtime_interview", "report_generation", "skill_execution"]);
const contextMemoryKinds = ["core", "working", "team"] as const;

function memoryKindForAssetType(assetType: string): ContextMemoryKind | null {
  if (assetType === "core_memory") return "core";
  if (assetType === "working_memory") return "working";
  if (assetType === "team_memory") return "team";
  return null;
}

export const contextAssetInputSchema = z.object({
  assetType: z.enum(["core_memory", "working_memory", "team_memory", "document", "research_sample", "persona", "study_context"]),
  scope: z.enum(["user", "workspace", "study"]).default("workspace"),
  studyPublicId: z.string().trim().min(8).max(120).nullable().default(null),
  title: z.string().trim().min(2).max(180),
  description: z.string().trim().max(1000).default(""),
  sourceUri: z.string().trim().url().max(2000).nullable().default(null),
  content: z.string().trim().min(1).max(200_000),
  changeNote: z.string().trim().max(500).default("Initial version"),
  ingestionMethod: z.enum(["manual", "file"]).default("manual"),
  sourceName: z.string().trim().max(500).nullable().default(null),
  sourceMimeType: z.string().trim().max(200).nullable().default(null),
  evidenceKind: z.enum(["human", "synthetic", "mixed", "not_applicable"]).default("not_applicable"),
  consentStatus: z.enum(["confirmed", "restricted", "unknown", "not_required"]).default("not_required"),
  piiStatus: z.enum(["none", "present", "redacted", "not_reviewed"]).default("not_reviewed"),
  retentionExpiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  memoryConfidence: z.enum(["low", "medium", "high"]).default("low"),
  reviewStatus: z.enum(["pending", "approved"]).default("approved"),
}).superRefine((input, context) => {
  if (input.scope === "study" && !input.studyPublicId) {
    context.addIssue({ code: "custom", path: ["studyPublicId"], message: "研究级 Context 必须绑定 study" });
  }
  if (input.scope !== "study" && input.studyPublicId) {
    context.addIssue({ code: "custom", path: ["studyPublicId"], message: "只有研究级 Context 可以绑定 study" });
  }
  if (input.assetType === "core_memory" && input.scope !== "user") {
    context.addIssue({ code: "custom", path: ["scope"], message: "Core Memory 必须使用个人范围" });
  }
  if (input.assetType === "team_memory" && input.scope !== "workspace") {
    context.addIssue({ code: "custom", path: ["scope"], message: "Team Memory 必须使用工作区范围" });
  }
  if (input.assetType === "working_memory" && input.scope === "workspace") {
    context.addIssue({ code: "custom", path: ["scope"], message: "Working Memory 必须绑定个人或研究" });
  }
  if (input.retentionExpiresAt && new Date(input.retentionExpiresAt).getTime() <= Date.now()) {
    context.addIssue({ code: "custom", path: ["retentionExpiresAt"], message: "保留期必须晚于当前时间" });
  }
});

export const contextMemoryPolicyInputSchema = z.object({
  allowedPurposes: z.array(contextPurposeSchema).min(1).max(6)
    .refine((purposes) => new Set(purposes).size === purposes.length, "Memory purpose 不能重复"),
  reviewRequired: z.boolean(),
  defaultRetentionDays: z.number().int().min(1).max(3650).nullable(),
  decayDays: z.number().int().min(1).max(3650).nullable(),
  promotionMinObservations: z.number().int().min(1).max(20),
  conflictStrategy: z.enum(["manual_review", "keep_parallel", "newest_verified"]),
});

export const contextBehaviorObservationInputSchema = z.object({
  sourceAssetPublicId: z.string().trim().min(8).max(120),
  observationType: z.enum(["preference", "habit", "constraint", "decision_signal"]),
  statement: z.string().trim().min(2).max(2000),
  evidenceKind: z.enum(["human_observation", "public_source", "synthetic_simulation", "model_inference"]),
  confidence: z.enum(["low", "medium", "high"]),
  observedAt: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }).nullable().default(null),
}).superRefine((input, context) => {
  if (input.validUntil && new Date(input.validUntil).getTime() <= new Date(input.observedAt).getTime()) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "行为观察的有效期必须晚于观察时间" });
  }
});

export const contextBehaviorObservationReviewSchema = z.object({
  observationPublicId: z.string().trim().min(8).max(120),
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).default(""),
}).superRefine((input, context) => {
  if (input.action === "reject" && input.note.length < 2) {
    context.addIssue({ code: "custom", path: ["note"], message: "拒绝行为观察时请填写原因" });
  }
});

export const contextMemoryPromotionSchema = z.object({
  targetMemoryKind: z.enum(["core", "team"]),
  note: z.string().trim().min(2).max(1000),
});

export const contextReviewInputSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).default(""),
}).superRefine((input, context) => {
  if (input.action === "reject" && input.note.length < 2) {
    context.addIssue({ code: "custom", path: ["note"], message: "拒绝资产时请填写原因" });
  }
});

export const contextEdgeInputSchema = z.object({
  targetPublicId: z.string().trim().min(8).max(120),
  relation: z.enum(["derived_from", "supports", "contradicts", "mentions", "supersedes", "related_to", "resolved_by"]),
  note: z.string().trim().max(500).default(""),
});

export const contextVersionInputSchema = z.object({
  content: z.string().trim().min(1).max(200_000),
  changeNote: z.string().trim().min(1).max(500),
});

export const contextTombstoneInputSchema = z.object({
  reason: z.string().trim().min(4).max(500),
});

export const contextEvaluationSetInputSchema = z.object({
  name: z.string().trim().min(2).max(180),
  description: z.string().trim().max(1000).default(""),
  labelingProtocol: z.literal("human_relevance_v1").default("human_relevance_v1"),
  cases: z.array(z.object({
    query: z.string().trim().min(2).max(1000),
    assetTypes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    scopes: z.array(z.enum(["user", "workspace", "study", "system"])).max(4).default([]),
    topK: z.number().int().min(1).max(20).default(8),
    expectedChunkPublicIds: z.array(z.string().trim().min(8).max(120)).min(1).max(30)
      .refine((publicIds) => new Set(publicIds).size === publicIds.length, "期望 chunk 不能重复"),
    labelNote: z.string().trim().min(2).max(1000),
  })).min(20, "human_relevance_v1 至少需要 20 条人工确认标签").max(100),
});

export const contextSearchInputSchema = z.object({
  query: z.string().trim().min(2).max(1000),
  assetTypes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  scopes: z.array(z.enum(["user", "workspace", "study", "system"])).max(4).default([]),
  purpose: contextPurposeSchema.default("general"),
  limit: z.number().int().min(1).max(20).default(8),
});

function chunkText(content: string, targetLength = 1200) {
  const paragraphs = content.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs.length ? paragraphs : [content]) {
    if (current && current.length + paragraph.length + 2 > targetLength) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length <= targetLength) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }
    if (current) chunks.push(current);
    for (let offset = 0; offset < paragraph.length; offset += targetLength) {
      chunks.push(paragraph.slice(offset, offset + targetLength));
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function queryTerms(query: string) {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  const words = normalized.match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  const terms = words.flatMap((word) => {
    if (!/[\p{Script=Han}]/u.test(word) || word.length <= 4) return [word];
    return [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))];
  });
  return [...new Set(terms)].slice(0, 40);
}

function embeddingTokens(value: string) {
  const normalized = value.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  const terms = queryTerms(normalized);
  const characters = [...normalized.replace(/\s/g, "")];
  const ngrams = characters.flatMap((_, index) => [
    characters.slice(index, index + 2).join(""),
    characters.slice(index, index + 3).join(""),
  ]).filter((item) => item.length >= 2);
  return [...terms, ...ngrams].slice(0, 2000);
}

export function createContextEmbedding(value: string) {
  const vector = Array.from({ length: CONTEXT_EMBEDDING_BASELINE.dimensions }, () => 0);
  for (const token of embeddingTokens(value)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % vector.length;
    vector[index] += digest[4] % 2 === 0 ? 1 : -1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return magnitude ? vector.map((item) => Number((item / magnitude).toFixed(8))) : vector;
}

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0;
  return left.reduce((sum, item, index) => sum + item * right[index], 0);
}

function getOpenAIEmbeddingModel() {
  return process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
}

function getOpenAIEmbeddingVersion() {
  return process.env.OPENAI_EMBEDDING_VERSION?.trim() || "openai-embeddings-v1";
}

function getOpenAIEmbeddingProviderName() {
  return process.env.OPENAI_EMBEDDING_PROVIDER_NAME?.trim() || "openai";
}

function getContextEmbeddingApiStyle(): ContextEmbeddingApiStyle {
  return process.env.CONTEXT_EMBEDDING_API_STYLE?.trim() === "volcengine_multimodal"
    ? "volcengine_multimodal"
    : "openai";
}

function getOpenAIEmbeddingBaseUrl() {
  return process.env.OPENAI_EMBEDDING_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim() || "";
}

function hasDedicatedEmbeddingEndpoint() {
  // A chat-only compatibility endpoint must not be silently reused for embeddings.
  return !process.env.OPENAI_BASE_URL?.trim() || Boolean(process.env.OPENAI_EMBEDDING_BASE_URL?.trim());
}

function getOpenAIEmbeddingApiKey() {
  return process.env.OPENAI_EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
}

function getContextEmbeddingBatchSize() {
  const configured = Number(process.env.CONTEXT_EMBEDDING_EVALUATION_BATCH_SIZE ?? 64);
  return Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 1), 128) : 64;
}

function getContextEmbeddingTimeoutMs() {
  const configured = Number(process.env.CONTEXT_EMBEDDING_EVALUATION_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 5_000), 120_000) : 60_000;
}

function resolveContextEmbeddingEvaluationTarget(
  input: z.infer<typeof contextEmbeddingEvaluationInputSchema>,
): ContextEmbeddingEvaluationTarget {
  if (input.provider === "baseline") {
    return {
      provider: "baseline",
      providerName: "deterministic-baseline",
      model: CONTEXT_EMBEDDING_BASELINE.model,
      version: CONTEXT_EMBEDDING_BASELINE.version,
    };
  }
  return {
    provider: "openai",
    providerName: getOpenAIEmbeddingProviderName(),
    model: input.model ?? getOpenAIEmbeddingModel(),
    version: getOpenAIEmbeddingVersion(),
  };
}

export function getContextEmbeddingProviderStatus() {
  return {
    baseline: CONTEXT_EMBEDDING_BASELINE,
    openai: {
      providerName: getOpenAIEmbeddingProviderName(),
      apiStyle: getContextEmbeddingApiStyle(),
      configured: Boolean(getOpenAIEmbeddingApiKey()) && hasDedicatedEmbeddingEndpoint(),
      model: getOpenAIEmbeddingModel(),
      version: getOpenAIEmbeddingVersion(),
    },
    evaluationGate: CONTEXT_PRODUCTION_EMBEDDING_GATE,
  };
}

function getContextEmbeddingClient() {
  const apiKey = getOpenAIEmbeddingApiKey();
  if (!apiKey) throw new Error("OPENAI_EMBEDDING_API_KEY_MISSING");
  contextEmbeddingClient ??= new OpenAI({
    apiKey,
    baseURL: getOpenAIEmbeddingBaseUrl() || undefined,
    timeout: getContextEmbeddingTimeoutMs(),
    maxRetries: 1,
  });
  return contextEmbeddingClient;
}

async function createOpenAIEmbeddings(texts: string[], model: string) {
  const vectors = new Map<string, number[]>();
  const batchSize = getContextEmbeddingBatchSize();
  let dimensions: number | null = null;
  let requestCount = 0;
  let promptTokens = 0;
  let totalTokens = 0;
  const startedAt = Date.now();
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const input = texts.slice(offset, offset + batchSize);
    const response = await getContextEmbeddingClient().embeddings.create({ model, input, encoding_format: "float" });
    requestCount += 1;
    promptTokens += response.usage?.prompt_tokens ?? 0;
    totalTokens += response.usage?.total_tokens ?? 0;
    const ordered = [...response.data].sort((left, right) => left.index - right.index);
    if (ordered.length !== input.length) throw new Error("OPENAI_EMBEDDING_RESPONSE_INCOMPLETE");
    for (const [index, item] of ordered.entries()) {
      const vector = item.embedding.map(Number);
      if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("OPENAI_EMBEDDING_RESPONSE_INVALID");
      }
      if (dimensions !== null && vector.length !== dimensions) throw new Error("OPENAI_EMBEDDING_DIMENSION_MISMATCH");
      dimensions ??= vector.length;
      vectors.set(input[index], vector);
    }
  }
  return {
    vectors,
    telemetry: {
      requestCount,
      inputCount: texts.length,
      dimensions,
      promptTokens,
      totalTokens,
      latencyMs: Date.now() - startedAt,
    },
  };
}

async function createVolcengineMultimodalEmbeddings(texts: string[], model: string) {
  const apiKey = getOpenAIEmbeddingApiKey();
  if (!apiKey) throw new Error("OPENAI_EMBEDDING_API_KEY_MISSING");
  const baseUrl = getOpenAIEmbeddingBaseUrl();
  if (!baseUrl) throw new Error("OPENAI_EMBEDDING_BASE_URL_MISSING");
  const endpoint = new URL("embeddings/multimodal", `${baseUrl.replace(/\/+$/, "")}/`);
  const vectors = new Map<string, number[]>();
  const concurrency = getContextEmbeddingBatchSize();
  let dimensions: number | null = null;
  let requestCount = 0;
  let promptTokens = 0;
  let totalTokens = 0;
  const startedAt = Date.now();

  for (let offset = 0; offset < texts.length; offset += concurrency) {
    const input = texts.slice(offset, offset + concurrency);
    const results = await Promise.all(input.map(async (text) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, input: [{ type: "text", text }] }),
        signal: AbortSignal.timeout(getContextEmbeddingTimeoutMs()),
      });
      if (!response.ok) throw new Error(`VOLCENGINE_EMBEDDING_REQUEST_FAILED_${response.status}`);
      const parsed = volcengineMultimodalEmbeddingResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("VOLCENGINE_EMBEDDING_RESPONSE_INVALID");
      const item = Array.isArray(parsed.data.data) ? parsed.data.data[0] : parsed.data.data;
      const vector = item.embedding.map(Number);
      if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("VOLCENGINE_EMBEDDING_RESPONSE_INVALID");
      }
      return {
        text,
        vector,
        promptTokens: parsed.data.usage?.prompt_tokens ?? parsed.data.usage?.input_tokens ?? 0,
        totalTokens: parsed.data.usage?.total_tokens ?? 0,
      };
    }));
    requestCount += results.length;
    for (const result of results) {
      if (dimensions !== null && result.vector.length !== dimensions) {
        throw new Error("OPENAI_EMBEDDING_DIMENSION_MISMATCH");
      }
      dimensions ??= result.vector.length;
      promptTokens += result.promptTokens;
      totalTokens += result.totalTokens;
      vectors.set(result.text, result.vector);
    }
  }

  return {
    vectors,
    telemetry: {
      requestCount,
      inputCount: texts.length,
      dimensions,
      promptTokens,
      totalTokens,
      latencyMs: Date.now() - startedAt,
    },
  };
}

function createProductionEmbeddings(texts: string[], model: string) {
  return getContextEmbeddingApiStyle() === "volcengine_multimodal"
    ? createVolcengineMultimodalEmbeddings(texts, model)
    : createOpenAIEmbeddings(texts, model);
}

function scoreCandidate(query: string, terms: string[], candidate: { title: string; content: string; asset_type: string }) {
  const title = candidate.title.toLowerCase();
  const content = candidate.content.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (content.includes(query.toLowerCase())) { score += 12; reasons.push("exact_content"); }
  if (title.includes(query.toLowerCase())) { score += 16; reasons.push("exact_title"); }
  for (const term of terms) {
    if (title.includes(term)) score += 4;
    if (content.includes(term)) score += 1;
  }
  if (terms.some((term) => title.includes(term))) reasons.push("title_term");
  if (terms.some((term) => content.includes(term))) reasons.push("content_term");
  if (candidate.asset_type.endsWith("memory")) { score += 0.25; reasons.push("memory_tiebreak"); }
  return { score, reasons };
}

function hashContextContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeCandidateText(value: string) {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function candidateExpiry(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const defaultMemoryPolicies: Array<{
  memoryKind: ContextMemoryKind;
  name: string;
  allowedPurposes: ContextPurpose[];
  defaultRetentionDays: number | null;
  decayDays: number | null;
}> = [
  {
    memoryKind: "core",
    name: "Core Memory",
    allowedPurposes: ["general", "intent_planning", "research_execution", "report_generation"],
    defaultRetentionDays: null,
    decayDays: 365,
  },
  {
    memoryKind: "working",
    name: "Working Memory",
    allowedPurposes: ["general", "research_execution", "realtime_interview", "report_generation"],
    defaultRetentionDays: 30,
    decayDays: 30,
  },
  {
    memoryKind: "team",
    name: "Team Memory",
    allowedPurposes: ["general", "intent_planning", "research_execution", "report_generation", "skill_execution"],
    defaultRetentionDays: null,
    decayDays: 730,
  },
];

async function ensureDefaultMemoryPolicies(queryable: Queryable, workspaceId: string, userId: string | null) {
  for (const policy of defaultMemoryPolicies) {
    await queryable.query(
      `insert into context_memory_policies (
         public_id, workspace_id, memory_kind, name, version, allowed_purposes,
         review_required, default_retention_days, decay_days, promotion_min_observations,
         conflict_strategy, created_by
       ) values ($1, $2, $3, $4, 1, $5::text[], true, $6, $7, 2, 'manual_review', $8)
       on conflict (workspace_id, memory_kind, version) do nothing`,
      [
        createPublicId("cmp"), workspaceId, policy.memoryKind, policy.name, policy.allowedPurposes,
        policy.defaultRetentionDays, policy.decayDays, userId,
      ],
    );
  }
}

async function appendContextMemoryEvent(queryable: Queryable, input: {
  workspaceId: string;
  assetId?: string | null;
  policyId?: string | null;
  observationId?: string | null;
  actorUserId: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  await queryable.query(
    `insert into context_memory_events (
       public_id, workspace_id, asset_id, policy_id, observation_id,
       actor_user_id, event_type, payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      createPublicId("cme"), input.workspaceId, input.assetId ?? null, input.policyId ?? null,
      input.observationId ?? null, input.actorUserId, input.eventType,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

async function bindContextMemory(queryable: Queryable, input: {
  workspaceId: string;
  assetId: string;
  assetType: string;
  scope: Exclude<ContextScope, "system">;
  createdBy: string;
  studyPublicId: string | null;
  confidence: "low" | "medium" | "high";
  validUntil: string | null;
  promotionStatus?: "none" | "candidate" | "promoted" | "rejected";
  subjectUserId?: string | null;
  actorUserId?: string | null;
  sourceObservationCount?: number;
}) {
  const memoryKind = memoryKindForAssetType(input.assetType);
  if (!memoryKind) return null;
  await ensureDefaultMemoryPolicies(queryable, input.workspaceId, input.createdBy);
  const policy = await queryable.query<{ id: string; public_id: string; version: number; default_retention_days: number | null }>(
    `select id::text as id, public_id, version, default_retention_days from context_memory_policies
     where workspace_id = $1 and memory_kind = $2 and status = 'active'
     order by version desc limit 1`,
    [input.workspaceId, memoryKind],
  );
  const selectedPolicy = policy.rows[0];
  if (!selectedPolicy) throw new Error("MEMORY_POLICY_NOT_FOUND");
  const subjectType = memoryKind === "team" ? "workspace" : input.scope === "study" ? "study" : "user";
  const effectiveValidUntil = input.validUntil ?? (selectedPolicy.default_retention_days
    ? new Date(Date.now() + selectedPolicy.default_retention_days * 86_400_000).toISOString()
    : null);
  const binding = await queryable.query<{ id: string; public_id: string }>(
    `insert into context_memory_bindings (
       public_id, workspace_id, asset_id, policy_id, memory_kind, subject_type,
       subject_user_id, subject_public_id, confidence, valid_until,
       promotion_status, created_by
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id::text as id, public_id`,
    [
      createPublicId("cmb"), input.workspaceId, input.assetId, selectedPolicy.id, memoryKind,
      subjectType, subjectType === "user" ? input.subjectUserId ?? input.createdBy : null,
      subjectType === "study" ? input.studyPublicId : null, input.confidence, effectiveValidUntil,
      input.promotionStatus ?? "none", input.createdBy,
    ],
  );
  if (input.sourceObservationCount) {
    await queryable.query(
      "update context_memory_bindings set source_observation_count = $2 where id = $1",
      [binding.rows[0].id, input.sourceObservationCount],
    );
  }
  await appendContextMemoryEvent(queryable, {
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    policyId: selectedPolicy.id,
    actorUserId: input.actorUserId ?? input.createdBy,
    eventType: "memory.bound",
    payload: {
      memoryKind,
      subjectType,
      subjectPublicId: subjectType === "study" ? input.studyPublicId : null,
      confidence: input.confidence,
      validUntil: effectiveValidUntil,
      policyPublicId: selectedPolicy.public_id,
      policyVersion: selectedPolicy.version,
    },
  });
  return { ...binding.rows[0], policyId: selectedPolicy.id };
}

type CandidateAssetRef = {
  id: string;
  public_id: string;
  retention_expires_at?: string | null;
};

async function appendContextAssetEvent(
  transaction: Queryable,
  input: {
    workspaceId: string;
    assetId: string;
    actorUserId: string | null;
    eventType: string;
    payload?: Record<string, unknown>;
  },
) {
  await transaction.query(
    `insert into context_asset_events (
       public_id, workspace_id, asset_id, actor_user_id, event_type, payload
     ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      createPublicId("cxe"), input.workspaceId, input.assetId, input.actorUserId,
      input.eventType, JSON.stringify(input.payload ?? {}),
    ],
  );
}

async function insertVersion(
  transaction: Queryable,
  input: { assetId: string; version: number; content: string; changeNote: string; userId: string },
) {
  const version = await transaction.query<{ id: string; public_id: string }>(
    `insert into context_asset_versions (public_id, asset_id, version, content, content_hash, change_note, created_by)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7)
     returning id::text as id, public_id`,
    [
      createPublicId("cxv"), input.assetId, input.version, JSON.stringify({ text: input.content }),
      hashContextContent(input.content), input.changeNote, input.userId,
    ],
  );
  for (const [ordinal, chunk] of chunkText(input.content).entries()) {
    const embedding = createContextEmbedding(chunk);
    await transaction.query(
      `insert into context_chunks (
         public_id, asset_version_id, ordinal, content, metadata, embedding,
         embedding_model, embedding_dimensions, embedding_indexed_at, index_generation
       ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, now(), 1)`,
      [
        createPublicId("cxc"), version.rows[0].id, ordinal, chunk,
        JSON.stringify({ characters: chunk.length, embeddingVersion: CONTEXT_EMBEDDING_BASELINE.version }),
        JSON.stringify(embedding), CONTEXT_EMBEDDING_BASELINE.model, embedding.length,
      ],
    );
  }
  return version.rows[0];
}

type InsertContextAssetInput = {
  workspaceId: string;
  createdBy: string;
  assetType: string;
  scope: Exclude<ContextScope, "system">;
  studyId: string | null;
  title: string;
  description: string;
  sourceUri: string | null;
  content: string;
  changeNote: string;
  ingestionMethod: "manual" | "file" | "study_output" | "interview_output" | "system";
  sourceName: string | null;
  sourceMimeType: string | null;
  evidenceKind: ContextEvidenceKind;
  consentStatus: "confirmed" | "restricted" | "unknown" | "not_required";
  piiStatus: "none" | "present" | "redacted" | "not_reviewed";
  retentionExpiresAt: string | null;
  reviewStatus: Exclude<ContextReviewStatus, "rejected">;
  originKind?: string | null;
  originPublicId?: string | null;
  candidateDedupeKey?: string | null;
  expiryPolicy?: "none" | "exclude_on_expiry";
  metadata?: Record<string, unknown>;
  actorUserId?: string;
};

async function insertContextAssetRecord(transaction: Queryable, input: InsertContextAssetInput) {
  const sourceHash = hashContextContent(input.content);
  const status = input.reviewStatus === "pending" ? "draft" : "active";
  const asset = await transaction.query<{ id: string; public_id: string }>(
    `insert into context_assets (
       public_id, workspace_id, created_by, asset_type, scope, study_id, title, description, source_uri,
       status, ingestion_method, source_name, source_mime_type, source_hash, evidence_kind,
       consent_status, pii_status, retention_expires_at, review_status, reviewed_by, reviewed_at,
       origin_kind, origin_public_id, candidate_dedupe_key, expiry_policy, metadata
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21,
       $22, $23, $24, $25, $26::jsonb
     ) returning id::text as id, public_id`,
    [
      createPublicId("cxa"), input.workspaceId, input.createdBy, input.assetType, input.scope, input.studyId,
      input.title, input.description, input.sourceUri, status, input.ingestionMethod, input.sourceName,
      input.sourceMimeType, sourceHash, input.evidenceKind, input.consentStatus, input.piiStatus,
      input.retentionExpiresAt, input.reviewStatus,
      input.reviewStatus === "approved" ? input.createdBy : null,
      input.reviewStatus === "approved" ? new Date().toISOString() : null,
      input.originKind ?? null, input.originPublicId ?? null,
      input.candidateDedupeKey ?? null, input.expiryPolicy ?? "none",
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const version = await insertVersion(transaction, {
    assetId: asset.rows[0].id,
    version: 1,
    content: input.content,
    changeNote: input.changeNote,
    userId: input.createdBy,
  });
  await appendContextAssetEvent(transaction, {
    workspaceId: input.workspaceId,
    assetId: asset.rows[0].id,
    actorUserId: input.actorUserId ?? input.createdBy,
    eventType: input.reviewStatus === "pending" ? "candidate.proposed" : "asset.imported",
    payload: {
      ingestionMethod: input.ingestionMethod,
      reviewStatus: input.reviewStatus,
      sourceHash,
      originKind: input.originKind ?? null,
      originPublicId: input.originPublicId ?? null,
      candidateDedupeKey: input.candidateDedupeKey ?? null,
      expiryPolicy: input.expiryPolicy ?? "none",
    },
  });
  return { ...asset.rows[0], versionPublicId: version.public_id, sourceHash };
}

export async function listContextAssets(viewer: Viewer) {
  const database = await getDatabase();
  await ensureDefaultMemoryPolicies(database, viewer.workspaceId, viewer.userId);
  const result = await database.query<{
    public_id: string; asset_type: string; scope: ContextScope; title: string; description: string;
    source_uri: string | null; current_version: number; status: string; updated_at: string;
    study_public_id: string | null; index_generation: number;
    tombstoned_at: string | null; tombstone_reason: string | null;
    ingestion_method: string; source_name: string | null; source_mime_type: string | null;
    source_hash: string; evidence_kind: ContextEvidenceKind;
    consent_status: string; pii_status: string; retention_expires_at: string | null;
    review_status: ContextReviewStatus; reviewed_at: string | null; review_note: string | null;
    creator_name: string | null; reviewer_name: string | null; origin_kind: string | null;
    origin_public_id: string | null; candidate_dedupe_key: string | null; expiry_policy: string;
    content_hash: string; content_preview: string;
    chunk_count: number; relation_count: number;
    memory_kind: ContextMemoryKind | null; memory_subject_type: string | null;
    memory_confidence: "low" | "medium" | "high" | null; memory_valid_until: string | null;
    memory_policy_public_id: string | null; memory_policy_version: number | null;
    promotion_status: string | null; source_observation_count: number;
    approved_observation_count: number;
  }>(
    `select asset.public_id, asset.asset_type, asset.scope, asset.title, asset.description,
            asset.source_uri, asset.current_version, asset.status,
            asset.updated_at::text as updated_at, study.public_id as study_public_id,
            asset.index_generation, asset.tombstoned_at::text as tombstoned_at, asset.tombstone_reason,
            asset.ingestion_method, asset.source_name, asset.source_mime_type, asset.source_hash,
            asset.evidence_kind, asset.consent_status, asset.pii_status,
            asset.retention_expires_at::text as retention_expires_at, asset.review_status,
            asset.reviewed_at::text as reviewed_at, asset.review_note,
            creator.display_name as creator_name, reviewer.display_name as reviewer_name,
            asset.origin_kind, asset.origin_public_id, asset.candidate_dedupe_key,
            asset.expiry_policy, version.content_hash,
            left(coalesce(version.content->>'text', ''), 320) as content_preview,
            (select count(*)::int from context_chunks chunk where chunk.asset_version_id = version.id) as chunk_count,
            (select count(*)::int from context_edges edge where edge.from_asset_id = asset.id or edge.to_asset_id = asset.id) as relation_count,
            memory.memory_kind, memory.subject_type as memory_subject_type,
            memory.confidence as memory_confidence, memory.valid_until::text as memory_valid_until,
            memory_policy.public_id as memory_policy_public_id, memory_policy.version as memory_policy_version,
            memory.promotion_status, coalesce(memory.source_observation_count, 0)::int as source_observation_count,
            (select count(*)::int from context_behavior_observations observation
             where observation.memory_asset_id = asset.id and observation.status = 'approved'
               and (observation.valid_until is null or observation.valid_until > now())) as approved_observation_count
     from context_assets asset
     left join studies study on study.id = asset.study_id
     join context_asset_versions version on version.asset_id = asset.id and version.version = asset.current_version
     left join users creator on creator.id = asset.created_by
     left join users reviewer on reviewer.id = asset.reviewed_by
     left join context_memory_bindings memory on memory.asset_id = asset.id
     left join context_memory_policies memory_policy
       on memory_policy.workspace_id = asset.workspace_id
      and memory_policy.memory_kind = memory.memory_kind and memory_policy.status = 'active'
     where asset.workspace_id = $1 and (asset.scope <> 'user' or asset.created_by = $2)
     order by asset.updated_at desc, asset.id desc limit 300`,
    [viewer.workspaceId, viewer.userId],
  );
  return result.rows.map((row) => ({
    publicId: row.public_id,
    assetType: row.asset_type,
    scope: row.scope,
    title: row.title,
    description: row.description,
    sourceUri: row.source_uri,
    studyPublicId: row.study_public_id,
    currentVersion: row.current_version,
    status: row.status,
    indexGeneration: row.index_generation,
    tombstonedAt: row.tombstoned_at,
    tombstoneReason: row.tombstone_reason,
    ingestionMethod: row.ingestion_method,
    sourceName: row.source_name,
    sourceMimeType: row.source_mime_type,
    sourceHash: row.source_hash,
    evidenceKind: row.evidence_kind,
    consentStatus: row.consent_status,
    piiStatus: row.pii_status,
    retentionExpiresAt: row.retention_expires_at,
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    creatorName: row.creator_name,
    reviewerName: row.reviewer_name,
    originKind: row.origin_kind,
    originPublicId: row.origin_public_id,
    candidateDedupeKey: row.candidate_dedupe_key,
    expiryPolicy: row.expiry_policy,
    contentHash: row.content_hash,
    contentPreview: row.content_preview,
    chunkCount: row.chunk_count,
    relationCount: row.relation_count,
    memoryKind: row.memory_kind,
    memorySubjectType: row.memory_subject_type,
    memoryConfidence: row.memory_confidence,
    memoryValidUntil: row.memory_valid_until,
    memoryPolicyPublicId: row.memory_policy_public_id,
    memoryPolicyVersion: row.memory_policy_version,
    promotionStatus: row.promotion_status,
    sourceObservationCount: row.source_observation_count,
    approvedObservationCount: row.approved_observation_count,
    updatedAt: row.updated_at,
  }));
}

export async function listContextMemoryPolicies(viewer: Viewer) {
  const database = await getDatabase();
  await ensureDefaultMemoryPolicies(database, viewer.workspaceId, viewer.userId);
  const result = await database.query<{
    public_id: string; memory_kind: ContextMemoryKind; name: string; version: number;
    allowed_purposes: ContextPurpose[] | string; review_required: boolean;
    default_retention_days: number | null; decay_days: number | null;
    promotion_min_observations: number; conflict_strategy: string;
    created_at: string; updated_at: string;
  }>(
    `select public_id, memory_kind, name, version, allowed_purposes, review_required,
            default_retention_days, decay_days, promotion_min_observations,
            conflict_strategy, created_at::text as created_at, updated_at::text as updated_at
     from context_memory_policies
     where workspace_id = $1 and status = 'active'
     order by array_position($2::text[], memory_kind), version desc`,
    [viewer.workspaceId, [...contextMemoryKinds]],
  );
  return result.rows.map((policy) => ({
    publicId: policy.public_id,
    memoryKind: policy.memory_kind,
    name: policy.name,
    version: policy.version,
    allowedPurposes: typeof policy.allowed_purposes === "string"
      ? JSON.parse(policy.allowed_purposes) as ContextPurpose[]
      : policy.allowed_purposes,
    reviewRequired: policy.review_required,
    defaultRetentionDays: policy.default_retention_days,
    decayDays: policy.decay_days,
    promotionMinObservations: policy.promotion_min_observations,
    conflictStrategy: policy.conflict_strategy,
    createdAt: policy.created_at,
    updatedAt: policy.updated_at,
  }));
}

export async function updateContextMemoryPolicy(
  viewer: Viewer,
  publicId: string,
  input: z.infer<typeof contextMemoryPolicyInputSchema>,
) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
  const normalized = contextMemoryPolicyInputSchema.parse(input);
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const current = await transaction.query<{
      id: string; memory_kind: ContextMemoryKind; name: string; version: number;
    }>(
      `select id::text as id, memory_kind, name, version
       from context_memory_policies
       where public_id = $1 and workspace_id = $2 and status = 'active'
       for update`,
      [publicId, viewer.workspaceId],
    );
    const policy = current.rows[0];
    if (!policy) return "not_found" as const;
    const nextVersion = policy.version + 1;
    await transaction.query(
      "update context_memory_policies set status = 'superseded', updated_at = now() where id = $1",
      [policy.id],
    );
    const next = await transaction.query<{ id: string; public_id: string }>(
      `insert into context_memory_policies (
         public_id, workspace_id, memory_kind, name, version, allowed_purposes,
         review_required, default_retention_days, decay_days, promotion_min_observations,
         conflict_strategy, created_by, supersedes_policy_id
       ) values ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12, $13)
       returning id::text as id, public_id`,
      [
        createPublicId("cmp"), viewer.workspaceId, policy.memory_kind, policy.name, nextVersion,
        normalized.allowedPurposes, normalized.reviewRequired, normalized.defaultRetentionDays,
        normalized.decayDays, normalized.promotionMinObservations, normalized.conflictStrategy,
        viewer.userId, policy.id,
      ],
    );
    await appendContextMemoryEvent(transaction, {
      workspaceId: viewer.workspaceId,
      policyId: next.rows[0].id,
      actorUserId: viewer.userId,
      eventType: "policy.versioned",
      payload: {
        memoryKind: policy.memory_kind,
        previousPublicId: publicId,
        previousVersion: policy.version,
        version: nextVersion,
      },
    });
    return { publicId: next.rows[0].public_id, memoryKind: policy.memory_kind, version: nextVersion };
  });
}

type ManagedMemoryAsset = {
  id: string; public_id: string; asset_type: string; scope: ContextScope; title: string;
  description: string; status: string; review_status: ContextReviewStatus; created_by: string;
  content: string; binding_id: string; binding_public_id: string; memory_kind: ContextMemoryKind;
  subject_type: string; subject_user_id: string | null; subject_public_id: string | null;
  confidence: "low" | "medium" | "high"; valid_from: string; valid_until: string | null;
  last_verified_at: string | null; promotion_status: string; source_observation_count: number;
  policy_id: string; policy_public_id: string; policy_version: number;
  allowed_purposes: ContextPurpose[] | string; review_required: boolean;
  default_retention_days: number | null; decay_days: number | null;
  promotion_min_observations: number; conflict_strategy: string;
};

async function loadManagedMemoryAsset(
  queryable: Queryable,
  viewer: Viewer,
  publicId: string,
  lock = false,
) {
  const result = await queryable.query<ManagedMemoryAsset>(
    `select asset.id::text as id, asset.public_id, asset.asset_type, asset.scope,
            asset.title, asset.description, asset.status, asset.review_status,
            asset.created_by::text as created_by, coalesce(version.content->>'text', '') as content,
            binding.id::text as binding_id, binding.public_id as binding_public_id,
            binding.memory_kind, binding.subject_type, binding.subject_user_id::text as subject_user_id,
            binding.subject_public_id, binding.confidence, binding.valid_from::text as valid_from,
            binding.valid_until::text as valid_until, binding.last_verified_at::text as last_verified_at,
            binding.promotion_status, binding.source_observation_count,
            policy.id::text as policy_id, policy.public_id as policy_public_id,
            policy.version as policy_version, policy.allowed_purposes, policy.review_required,
            policy.default_retention_days, policy.decay_days, policy.promotion_min_observations,
            policy.conflict_strategy
     from context_assets asset
     join context_asset_versions version
       on version.asset_id = asset.id and version.version = asset.current_version
     join context_memory_bindings binding on binding.asset_id = asset.id
     join context_memory_policies policy
       on policy.workspace_id = asset.workspace_id
      and policy.memory_kind = binding.memory_kind and policy.status = 'active'
     where asset.public_id = $1 and asset.workspace_id = $2
       and (asset.scope <> 'user' or asset.created_by = $3)
     ${lock ? "for update of asset, binding" : ""}`,
    [publicId, viewer.workspaceId, viewer.userId],
  );
  return result.rows[0] ?? null;
}

export async function getContextMemoryDetail(viewer: Viewer, publicId: string) {
  const database = await getDatabase();
  const memory = await loadManagedMemoryAsset(database, viewer, publicId);
  if (!memory) return "not_found" as const;
  const [observations, events] = await Promise.all([
    database.query<{
      public_id: string; observation_type: string; statement: string; evidence_kind: string;
      confidence: string; observed_at: string; valid_until: string | null; status: string;
      reviewed_at: string | null; review_note: string | null; source_public_id: string | null;
      source_title: string | null; creator_name: string | null; reviewer_name: string | null;
    }>(
      `select observation.public_id, observation.observation_type, observation.statement,
              observation.evidence_kind, observation.confidence,
              observation.observed_at::text as observed_at,
              observation.valid_until::text as valid_until, observation.status,
              observation.reviewed_at::text as reviewed_at, observation.review_note,
              source.public_id as source_public_id, source.title as source_title,
              creator.display_name as creator_name, reviewer.display_name as reviewer_name
       from context_behavior_observations observation
       left join context_assets source on source.id = observation.source_asset_id
       left join users creator on creator.id = observation.created_by
       left join users reviewer on reviewer.id = observation.reviewed_by
       where observation.memory_asset_id = $1
       order by observation.observed_at desc, observation.id desc`,
      [memory.id],
    ),
    database.query<{
      public_id: string; event_type: string; payload: Record<string, unknown> | string;
      created_at: string; actor_name: string | null;
    }>(
      `select event.public_id, event.event_type, event.payload,
              event.created_at::text as created_at, actor.display_name as actor_name
       from context_memory_events event
       left join users actor on actor.id = event.actor_user_id
       where event.asset_id = $1
       order by event.created_at desc, event.id desc limit 100`,
      [memory.id],
    ),
  ]);
  return {
    publicId: memory.public_id,
    title: memory.title,
    description: memory.description,
    status: memory.status,
    reviewStatus: memory.review_status,
    memoryKind: memory.memory_kind,
    binding: {
      publicId: memory.binding_public_id,
      subjectType: memory.subject_type,
      subjectPublicId: memory.subject_public_id,
      confidence: memory.confidence,
      validFrom: memory.valid_from,
      validUntil: memory.valid_until,
      lastVerifiedAt: memory.last_verified_at,
      promotionStatus: memory.promotion_status,
      sourceObservationCount: memory.source_observation_count,
    },
    policy: {
      publicId: memory.policy_public_id,
      version: memory.policy_version,
      allowedPurposes: typeof memory.allowed_purposes === "string"
        ? JSON.parse(memory.allowed_purposes) as ContextPurpose[]
        : memory.allowed_purposes,
      reviewRequired: memory.review_required,
      defaultRetentionDays: memory.default_retention_days,
      decayDays: memory.decay_days,
      promotionMinObservations: memory.promotion_min_observations,
      conflictStrategy: memory.conflict_strategy,
    },
    observations: observations.rows.map((observation) => ({
      publicId: observation.public_id,
      observationType: observation.observation_type,
      statement: observation.statement,
      evidenceKind: observation.evidence_kind,
      confidence: observation.confidence,
      observedAt: observation.observed_at,
      validUntil: observation.valid_until,
      status: observation.status,
      reviewedAt: observation.reviewed_at,
      reviewNote: observation.review_note,
      sourceAssetPublicId: observation.source_public_id,
      sourceAssetTitle: observation.source_title,
      creatorName: observation.creator_name,
      reviewerName: observation.reviewer_name,
    })),
    events: events.rows.map((event) => ({
      publicId: event.public_id,
      eventType: event.event_type,
      payload: typeof event.payload === "string" ? JSON.parse(event.payload) as Record<string, unknown> : event.payload,
      createdAt: event.created_at,
      actorName: event.actor_name,
    })),
  };
}

export async function createContextBehaviorObservation(
  viewer: Viewer,
  memoryPublicId: string,
  input: z.infer<typeof contextBehaviorObservationInputSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const normalized = contextBehaviorObservationInputSchema.parse(input);
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const memory = await loadManagedMemoryAsset(transaction, viewer, memoryPublicId, true);
    if (!memory) return "not_found" as const;
    if (memory.memory_kind !== "working") return "not_working_memory" as const;
    if (memory.status === "tombstoned") return "tombstoned" as const;
    const source = await transaction.query<{ id: string }>(
      `select id::text as id from context_assets
       where public_id = $1 and workspace_id = $2 and status <> 'tombstoned'
         and (scope <> 'user' or created_by = $3) limit 1`,
      [normalized.sourceAssetPublicId, viewer.workspaceId, viewer.userId],
    );
    if (!source.rows[0]) return "source_not_found" as const;
    if (source.rows[0].id === memory.id) return "self_source" as const;
    const contentHash = hashContextContent(JSON.stringify({
      sourceAssetId: source.rows[0].id,
      observationType: normalized.observationType,
      statement: normalized.statement.replace(/\s+/g, " ").trim(),
      evidenceKind: normalized.evidenceKind,
      observedAt: normalized.observedAt,
    }));
    const observation = await transaction.query<{ id: string; public_id: string }>(
      `insert into context_behavior_observations (
         public_id, workspace_id, memory_asset_id, source_asset_id, observation_type,
         statement, evidence_kind, confidence, observed_at, valid_until, content_hash, created_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (memory_asset_id, content_hash) do nothing
       returning id::text as id, public_id`,
      [
        createPublicId("cbo"), viewer.workspaceId, memory.id, source.rows[0].id,
        normalized.observationType, normalized.statement, normalized.evidenceKind,
        normalized.confidence, normalized.observedAt, normalized.validUntil, contentHash, viewer.userId,
      ],
    );
    if (!observation.rows[0]) return "duplicate" as const;
    await appendContextMemoryEvent(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: memory.id,
      policyId: memory.policy_id,
      observationId: observation.rows[0].id,
      actorUserId: viewer.userId,
      eventType: "observation.proposed",
      payload: { sourceAssetPublicId: normalized.sourceAssetPublicId, evidenceKind: normalized.evidenceKind },
    });
    return { publicId: observation.rows[0].public_id, status: "pending" as const };
  });
}

export async function reviewContextBehaviorObservation(
  viewer: Viewer,
  memoryPublicId: string,
  input: z.infer<typeof contextBehaviorObservationReviewSchema>,
) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
  const normalized = contextBehaviorObservationReviewSchema.parse(input);
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const memory = await loadManagedMemoryAsset(transaction, viewer, memoryPublicId, true);
    if (!memory) return "not_found" as const;
    const observation = await transaction.query<{ id: string; status: string }>(
      `select id::text as id, status from context_behavior_observations
       where public_id = $1 and memory_asset_id = $2 for update`,
      [normalized.observationPublicId, memory.id],
    );
    if (!observation.rows[0]) return "observation_not_found" as const;
    const status = normalized.action === "approve" ? "approved" : "rejected";
    if (observation.rows[0].status !== status) {
      await transaction.query(
        `update context_behavior_observations set status = $2, reviewed_by = $3,
                reviewed_at = now(), review_note = $4, updated_at = now() where id = $1`,
        [observation.rows[0].id, status, viewer.userId, normalized.note],
      );
      await appendContextMemoryEvent(transaction, {
        workspaceId: viewer.workspaceId,
        assetId: memory.id,
        policyId: memory.policy_id,
        observationId: observation.rows[0].id,
        actorUserId: viewer.userId,
        eventType: status === "approved" ? "observation.approved" : "observation.rejected",
        payload: { note: normalized.note },
      });
    }
    const count = await transaction.query<{ count: number }>(
      `select count(*)::int as count from context_behavior_observations
       where memory_asset_id = $1 and status = 'approved'
         and (valid_until is null or valid_until > now())`,
      [memory.id],
    );
    await transaction.query(
      "update context_memory_bindings set source_observation_count = $2, updated_at = now() where id = $1",
      [memory.binding_id, count.rows[0]?.count ?? 0],
    );
    return { publicId: normalized.observationPublicId, status, approvedObservationCount: count.rows[0]?.count ?? 0 };
  });
}

export async function promoteContextMemory(
  viewer: Viewer,
  memoryPublicId: string,
  input: z.infer<typeof contextMemoryPromotionSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const normalized = contextMemoryPromotionSchema.parse(input);
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const memory = await loadManagedMemoryAsset(transaction, viewer, memoryPublicId, true);
    if (!memory) return "not_found" as const;
    if (memory.memory_kind !== "working") return "not_working_memory" as const;
    if (memory.status !== "active" || memory.review_status !== "approved") return "memory_not_approved" as const;
    const existing = await transaction.query<{ public_id: string }>(
      `select public_id from context_assets
       where workspace_id = $1 and origin_kind = $2 and origin_public_id = $3
         and asset_type = $4 and status <> 'tombstoned' limit 1`,
      [viewer.workspaceId, `memory_promotion_${normalized.targetMemoryKind}`, memoryPublicId, `${normalized.targetMemoryKind}_memory`],
    );
    if (existing.rows[0]) return { publicId: existing.rows[0].public_id, status: "existing_candidate" as const };
    const observations = await transaction.query<{
      public_id: string; observation_type: string; statement: string; evidence_kind: string;
      confidence: "low" | "medium" | "high"; observed_at: string;
      source_public_id: string; source_title: string;
    }>(
      `select observation.public_id, observation.observation_type, observation.statement,
              observation.evidence_kind, observation.confidence,
              observation.observed_at::text as observed_at,
              source.public_id as source_public_id, source.title as source_title
       from context_behavior_observations observation
       join context_assets source on source.id = observation.source_asset_id
       where observation.memory_asset_id = $1 and observation.status = 'approved'
         and (observation.valid_until is null or observation.valid_until > now())
       order by observation.observed_at, observation.id`,
      [memory.id],
    );
    if (observations.rows.length < memory.promotion_min_observations) {
      return { status: "insufficient_observations" as const, required: memory.promotion_min_observations, actual: observations.rows.length };
    }
    const content = [
      `# ${memory.title}`,
      "",
      `Promotion note: ${normalized.note}`,
      "",
      ...observations.rows.flatMap((observation) => [
        `- ${observation.statement}`,
        `  Evidence: ${observation.evidence_kind}; ${observation.source_title} (${observation.source_public_id}); observed ${observation.observed_at}`,
      ]),
    ].join("\n").slice(0, 200_000);
    const targetAssetType = `${normalized.targetMemoryKind}_memory`;
    const targetScope = normalized.targetMemoryKind === "core" ? "user" : "workspace";
    const confidence = observations.rows.every((observation) => observation.confidence === "high")
      ? "high" as const
      : observations.rows.some((observation) => observation.confidence !== "low") ? "medium" as const : "low" as const;
    const candidate = await insertContextAssetRecord(transaction, {
      workspaceId: viewer.workspaceId,
      createdBy: memory.created_by,
      actorUserId: viewer.userId,
      assetType: targetAssetType,
      scope: targetScope,
      studyId: null,
      title: `${normalized.targetMemoryKind === "core" ? "Core" : "Team"} candidate: ${memory.title}`,
      description: `由 Working Memory ${memoryPublicId} 的 ${observations.rows.length} 条已审核观察晋升`,
      sourceUri: null,
      content,
      changeNote: normalized.note,
      ingestionMethod: "system",
      sourceName: memory.title,
      sourceMimeType: "text/markdown",
      evidenceKind: "human",
      consentStatus: "confirmed",
      piiStatus: "not_reviewed",
      retentionExpiresAt: null,
      reviewStatus: "pending",
      originKind: `memory_promotion_${normalized.targetMemoryKind}`,
      originPublicId: memoryPublicId,
      metadata: {
        sourceMemoryPublicId: memoryPublicId,
        sourceObservationPublicIds: observations.rows.map((observation) => observation.public_id),
      },
    });
    const binding = await bindContextMemory(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: candidate.id,
      assetType: targetAssetType,
      scope: targetScope,
      createdBy: memory.created_by,
      actorUserId: viewer.userId,
      subjectUserId: normalized.targetMemoryKind === "core" ? memory.created_by : null,
      studyPublicId: null,
      confidence,
      validUntil: null,
      promotionStatus: "candidate",
      sourceObservationCount: observations.rows.length,
    });
    await transaction.query(
      `insert into context_edges (workspace_id, from_asset_id, to_asset_id, relation, metadata, created_by)
       values ($1, $2, $3, 'derived_from', $4::jsonb, $5)
       on conflict (from_asset_id, to_asset_id, relation) do nothing`,
      [viewer.workspaceId, candidate.id, memory.id, JSON.stringify({ observationCount: observations.rows.length }), viewer.userId],
    );
    await transaction.query(
      `update context_memory_bindings set promotion_status = 'promoted',
              source_observation_count = $2, updated_at = now() where id = $1`,
      [memory.binding_id, observations.rows.length],
    );
    await appendContextMemoryEvent(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: memory.id,
      policyId: memory.policy_id,
      actorUserId: viewer.userId,
      eventType: "promotion.proposed",
      payload: { targetMemoryKind: normalized.targetMemoryKind, candidatePublicId: candidate.public_id, note: normalized.note },
    });
    await appendContextMemoryEvent(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: candidate.id,
      policyId: binding?.policyId ?? null,
      actorUserId: viewer.userId,
      eventType: "promotion.candidate_created",
      payload: { sourceMemoryPublicId: memoryPublicId, observationCount: observations.rows.length },
    });
    return { publicId: candidate.public_id, status: "pending" as const, observationCount: observations.rows.length };
  });
}

export async function createContextAsset(viewer: Viewer, input: z.input<typeof contextAssetInputSchema>) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const normalized = contextAssetInputSchema.parse(input);
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    let studyId: string | null = null;
    if (normalized.studyPublicId) {
      const study = await transaction.query<{ id: string }>(
        "select id::text as id from studies where public_id = $1 and workspace_id = $2 limit 1",
        [normalized.studyPublicId, viewer.workspaceId],
      );
      if (!study.rows[0]) return "study_not_found" as const;
      studyId = study.rows[0].id;
    }
    const asset = await insertContextAssetRecord(transaction, {
      workspaceId: viewer.workspaceId,
      createdBy: viewer.userId,
      assetType: normalized.assetType,
      scope: normalized.scope,
      studyId,
      title: normalized.title,
      description: normalized.description,
      sourceUri: normalized.sourceUri,
      content: normalized.content,
      changeNote: normalized.changeNote,
      ingestionMethod: normalized.ingestionMethod,
      sourceName: normalized.sourceName,
      sourceMimeType: normalized.sourceMimeType,
      evidenceKind: normalized.evidenceKind,
      consentStatus: normalized.consentStatus,
      piiStatus: normalized.piiStatus,
      retentionExpiresAt: normalized.retentionExpiresAt,
      reviewStatus: normalized.reviewStatus,
    });
    const memory = await bindContextMemory(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: asset.id,
      assetType: normalized.assetType,
      scope: normalized.scope,
      createdBy: viewer.userId,
      studyPublicId: normalized.studyPublicId,
      confidence: normalized.memoryConfidence,
      validUntil: normalized.retentionExpiresAt,
    });
    if (memory) {
      await transaction.query(
        `update context_assets set retention_expires_at = binding.valid_until
         from context_memory_bindings binding
         where context_assets.id = $1 and binding.asset_id = context_assets.id`,
        [asset.id],
      );
    }
    return { publicId: asset.public_id, versionPublicId: asset.versionPublicId, version: 1 };
  });
}

export async function publishContextVersion(
  viewer: Viewer,
  publicId: string,
  input: z.infer<typeof contextVersionInputSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; current_version: number; created_by: string; scope: ContextScope }>(
      `select id::text as id, current_version, created_by::text as created_by, scope
       from context_assets where public_id = $1 and workspace_id = $2 for update`,
      [publicId, viewer.workspaceId],
    );
    const asset = result.rows[0];
    if (!asset) return "not_found" as const;
    if ((asset.scope === "user" || viewer.role === "member") && asset.created_by !== viewer.userId) return "forbidden" as const;
    const versionNumber = asset.current_version + 1;
    const version = await insertVersion(transaction, {
      assetId: asset.id, version: versionNumber, content: input.content, changeNote: input.changeNote, userId: viewer.userId,
    });
    await transaction.query(
      `update context_assets set current_version = $2, source_hash = $3,
              review_status = 'pending', status = 'draft', reviewed_by = null,
              reviewed_at = null, review_note = null, updated_at = now()
       where id = $1`,
      [asset.id, versionNumber, hashContextContent(input.content)],
    );
    await appendContextAssetEvent(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: asset.id,
      actorUserId: viewer.userId,
      eventType: "version.published",
      payload: { version: versionNumber, changeNote: input.changeNote, reviewStatus: "pending" },
    });
    return { publicId, versionPublicId: version.public_id, version: versionNumber };
  });
}

async function loadManagedContextAsset(queryable: Queryable, viewer: Viewer, publicId: string, lock = false) {
  const result = await queryable.query<{
    id: string; current_version: number; created_by: string; scope: ContextScope;
    asset_type: string; status: string; index_generation: number; retention_expires_at: string | null;
  }>(
    `select id::text as id, current_version, created_by::text as created_by, scope,
            asset_type, status, index_generation, retention_expires_at::text as retention_expires_at
     from context_assets where public_id = $1 and workspace_id = $2${lock ? " for update" : ""}`,
    [publicId, viewer.workspaceId],
  );
  const asset = result.rows[0];
  if (!asset) return "not_found" as const;
  if ((asset.scope === "user" || viewer.role === "member") && asset.created_by !== viewer.userId) return "forbidden" as const;
  return asset;
}

export async function tombstoneContextAsset(viewer: Viewer, publicId: string, reason: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const asset = await loadManagedContextAsset(transaction, viewer, publicId, true);
    if (typeof asset === "string") return asset;
    if (asset.status === "tombstoned") return { publicId, status: "tombstoned" as const };
    await transaction.query(
      `update context_assets set status = 'tombstoned', tombstoned_at = now(),
              tombstone_reason = $2, updated_at = now() where id = $1`,
      [asset.id, reason],
    );
    await appendContextAssetEvent(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: asset.id,
      actorUserId: viewer.userId,
      eventType: "asset.tombstoned",
      payload: { reason },
    });
    return { publicId, status: "tombstoned" as const };
  });
}

export async function reviewContextAsset(
  viewer: Viewer,
  publicId: string,
  input: z.infer<typeof contextReviewInputSchema>,
) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const asset = await loadManagedContextAsset(transaction, viewer, publicId, true);
    if (typeof asset === "string") return asset;
    if (asset.status === "tombstoned") return "tombstoned" as const;
    if (input.action === "approve" && asset.retention_expires_at
      && new Date(asset.retention_expires_at).getTime() <= Date.now()) return "expired" as const;
    const approved = input.action === "approve";
    await transaction.query(
      `update context_assets set status = $2, review_status = $3, reviewed_by = $4,
              reviewed_at = now(), review_note = $5, updated_at = now()
       where id = $1`,
      [asset.id, approved ? "active" : "archived", approved ? "approved" : "rejected", viewer.userId, input.note],
    );
    await appendContextAssetEvent(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: asset.id,
      actorUserId: viewer.userId,
      eventType: approved ? "review.approved" : "review.rejected",
      payload: { note: input.note },
    });
    return {
      publicId,
      status: approved ? "active" as const : "archived" as const,
      reviewStatus: approved ? "approved" as const : "rejected" as const,
    };
  });
}

export async function createContextEdge(
  viewer: Viewer,
  sourcePublicId: string,
  input: z.infer<typeof contextEdgeInputSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  if (sourcePublicId === input.targetPublicId) return "self_relation" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const source = await loadManagedContextAsset(transaction, viewer, sourcePublicId);
    if (typeof source === "string") return source === "not_found" ? "source_not_found" as const : source;
    const target = await loadManagedContextAsset(transaction, viewer, input.targetPublicId);
    if (typeof target === "string") return target === "not_found" ? "target_not_found" as const : target;
    if (source.status === "tombstoned" || target.status === "tombstoned") return "tombstoned" as const;
    await transaction.query(
      `insert into context_edges (workspace_id, from_asset_id, to_asset_id, relation, metadata, created_by)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (from_asset_id, to_asset_id, relation)
       do update set metadata = excluded.metadata, created_by = excluded.created_by`,
      [viewer.workspaceId, source.id, target.id, input.relation, JSON.stringify({ note: input.note }), viewer.userId],
    );
    await appendContextAssetEvent(transaction, {
      workspaceId: viewer.workspaceId,
      assetId: source.id,
      actorUserId: viewer.userId,
      eventType: "relation.created",
      payload: { targetPublicId: input.targetPublicId, relation: input.relation, note: input.note },
    });
    if (input.relation === "resolved_by" && source.asset_type === "knowledge_gap" && target.status === "active") {
      await transaction.query(
        `update context_assets set status = 'archived', updated_at = now() where id = $1`,
        [source.id],
      );
      await appendContextAssetEvent(transaction, {
        workspaceId: viewer.workspaceId,
        assetId: source.id,
        actorUserId: viewer.userId,
        eventType: "knowledge_gap.resolved",
        payload: { evidenceAssetPublicId: input.targetPublicId, note: input.note },
      });
    }
    return { sourcePublicId, targetPublicId: input.targetPublicId, relation: input.relation };
  });
}

export async function proposeStudyContextCandidates(
  transaction: Queryable,
  input: {
    workspaceId: string;
    userId: string;
    studyPublicId: string;
    report: {
      publicId: string;
      title: string;
      executiveSummary: string;
      content: unknown;
    };
    personas: Array<{ publicId: string; name: string; profile: unknown }>;
    study: {
      brief: string;
      studyType: string;
      framework: string;
      methods: string[];
      audience: string;
      personaCount: number;
      workflowType: string;
      workflowVersion: string;
      taskGraph: Array<{
        key: string;
        title: string;
        toolName: string;
        dependsOn: string[];
      }>;
    };
  },
) {
  async function existingOrigin(originKind: string, originPublicId: string, assetType: string) {
    const result = await transaction.query<{ id: string; public_id: string }>(
      `select id::text as id, public_id from context_assets
       where workspace_id = $1 and origin_kind = $2 and origin_public_id = $3
         and asset_type = $4 and status <> 'tombstoned'
       limit 1`,
      [input.workspaceId, originKind, originPublicId, assetType],
    );
    return result.rows[0] ?? null;
  }

  async function linkDerivedAsset(assetId: string, reportAssetId: string, candidateKind: string) {
    await transaction.query(
      `insert into context_edges (workspace_id, from_asset_id, to_asset_id, relation, metadata, created_by)
       values ($1, $2, $3, 'derived_from', $4::jsonb, $5)
       on conflict (from_asset_id, to_asset_id, relation) do nothing`,
      [
        input.workspaceId, assetId, reportAssetId,
        JSON.stringify({ studyPublicId: input.studyPublicId, candidateKind }), input.userId,
      ],
    );
  }

  async function reusableCandidate(
    assetType: "research_template" | "knowledge_gap",
    dedupeKey: string,
  ): Promise<CandidateAssetRef | null> {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.workspaceId}:${assetType}:${dedupeKey}`,
    ]);
    const result = await transaction.query<{
      id: string; public_id: string; retention_expires_at: string | null;
    }>(
      `select id::text as id, public_id, retention_expires_at::text as retention_expires_at
       from context_assets
       where workspace_id = $1 and asset_type = $2 and candidate_dedupe_key = $3
         and status in ('draft', 'active')
       for update`,
      [input.workspaceId, assetType, dedupeKey],
    );
    const existing = result.rows[0] ?? null;
    if (!existing?.retention_expires_at
      || new Date(existing.retention_expires_at).getTime() > Date.now()) return existing;
    await transaction.query(
      "update context_assets set status = 'archived', updated_at = now() where id = $1",
      [existing.id],
    );
    await appendContextAssetEvent(transaction, {
      workspaceId: input.workspaceId,
      assetId: existing.id,
      actorUserId: input.userId,
      eventType: "candidate.expired",
      payload: { replacementStudyPublicId: input.studyPublicId },
    });
    return null;
  }

  async function recordDuplicate(asset: { id: string; public_id: string }, candidateKind: string) {
    const recorded = await transaction.query<{ exists: boolean }>(
      `select exists(
         select 1 from context_asset_events
         where asset_id = $1 and event_type = 'candidate.duplicate_detected'
           and payload->>'studyPublicId' = $2 and payload->>'reportPublicId' = $3
       ) as exists`,
      [asset.id, input.studyPublicId, input.report.publicId],
    );
    if (recorded.rows[0]?.exists) return;
    await appendContextAssetEvent(transaction, {
      workspaceId: input.workspaceId,
      assetId: asset.id,
      actorUserId: input.userId,
      eventType: "candidate.duplicate_detected",
      payload: {
        candidateKind,
        studyPublicId: input.studyPublicId,
        reportPublicId: input.report.publicId,
      },
    });
  }

  const reportContent = JSON.stringify(input.report.content, null, 2).slice(0, 200_000);
  let reportAsset = await existingOrigin("report", input.report.publicId, "research_sample");
  let proposed = 0;
  let duplicates = 0;
  if (!reportAsset) {
    const inserted = await insertContextAssetRecord(transaction, {
      workspaceId: input.workspaceId,
      createdBy: input.userId,
      assetType: "research_sample",
      scope: "workspace",
      studyId: null,
      title: input.report.title,
      description: input.report.executiveSummary.slice(0, 1000),
      sourceUri: null,
      content: reportContent,
      changeNote: "Generated from completed study",
      ingestionMethod: "study_output",
      sourceName: `Study ${input.studyPublicId}`,
      sourceMimeType: "application/json",
      evidenceKind: "mixed",
      consentStatus: "unknown",
      piiStatus: "not_reviewed",
      retentionExpiresAt: null,
      reviewStatus: "pending",
      originKind: "report",
      originPublicId: input.report.publicId,
      metadata: { studyPublicId: input.studyPublicId, candidateKind: "study_report" },
    });
    reportAsset = { id: inserted.id, public_id: inserted.public_id };
    proposed += 1;
  }

  for (const persona of input.personas) {
    let personaAsset = await existingOrigin("study_persona", persona.publicId, "persona");
    if (!personaAsset) {
      const inserted = await insertContextAssetRecord(transaction, {
        workspaceId: input.workspaceId,
        createdBy: input.userId,
        assetType: "persona",
        scope: "workspace",
        studyId: null,
        title: persona.name,
        description: `AI 合成 Persona，来自研究 ${input.studyPublicId}`,
        sourceUri: null,
        content: JSON.stringify(persona.profile, null, 2).slice(0, 200_000),
        changeNote: "Generated from completed study",
        ingestionMethod: "study_output",
        sourceName: `Study ${input.studyPublicId}`,
        sourceMimeType: "application/json",
        evidenceKind: "synthetic",
        consentStatus: "not_required",
        piiStatus: "none",
        retentionExpiresAt: null,
        reviewStatus: "pending",
        originKind: "study_persona",
        originPublicId: persona.publicId,
        metadata: { studyPublicId: input.studyPublicId, candidateKind: "synthetic_persona" },
      });
      personaAsset = { id: inserted.id, public_id: inserted.public_id };
      proposed += 1;
    }
    await transaction.query(
      `insert into context_edges (workspace_id, from_asset_id, to_asset_id, relation, metadata, created_by)
       values ($1, $2, $3, 'derived_from', $4::jsonb, $5)
       on conflict (from_asset_id, to_asset_id, relation) do nothing`,
      [
        input.workspaceId, personaAsset.id, reportAsset.id,
        JSON.stringify({ studyPublicId: input.studyPublicId }), input.userId,
      ],
    );
  }

  const normalizedTasks = input.study.taskGraph
    .map((task) => ({
      key: task.key,
      title: task.title,
      toolName: task.toolName,
      dependsOn: [...task.dependsOn].sort(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const templateSignature = {
    schemaVersion: "research-template-dedupe-v1",
    studyType: input.study.studyType,
    framework: normalizeCandidateText(input.study.framework),
    methods: input.study.methods.map(normalizeCandidateText).sort(),
    workflowType: input.study.workflowType,
    workflowVersion: input.study.workflowVersion,
    taskGraph: normalizedTasks.map((task) => ({
      key: task.key,
      toolName: task.toolName,
      dependsOn: task.dependsOn,
    })),
  };
  const templateDedupeKey = hashContextContent(JSON.stringify(templateSignature));
  let templateAsset = await reusableCandidate("research_template", templateDedupeKey);
  if (!templateAsset) {
    const templateContent = JSON.stringify({
      schemaVersion: "research-template-v1",
      name: `${input.study.framework} · ${input.study.methods.join(" + ")}`,
      applicability: {
        studyType: input.study.studyType,
        audience: input.study.audience,
        objectiveExample: input.study.brief,
      },
      design: {
        framework: input.study.framework,
        methods: input.study.methods,
        personaCount: input.study.personaCount,
      },
      workflow: {
        type: input.study.workflowType,
        version: input.study.workflowVersion,
        tasks: normalizedTasks,
      },
      provenance: {
        studyPublicId: input.studyPublicId,
        reportPublicId: input.report.publicId,
      },
    }, null, 2);
    const inserted = await insertContextAssetRecord(transaction, {
      workspaceId: input.workspaceId,
      createdBy: input.userId,
      assetType: "research_template",
      scope: "workspace",
      studyId: null,
      title: `研究模板：${input.study.framework}`.slice(0, 180),
      description: `${input.study.methods.join("、")} · ${input.study.audience}`.slice(0, 1000),
      sourceUri: null,
      content: templateContent,
      changeNote: "Generated from completed study workflow",
      ingestionMethod: "study_output",
      sourceName: `Study ${input.studyPublicId}`,
      sourceMimeType: "application/json",
      evidenceKind: "mixed",
      consentStatus: "not_required",
      piiStatus: "none",
      retentionExpiresAt: candidateExpiry(365),
      reviewStatus: "pending",
      originKind: "workflow_template",
      originPublicId: input.report.publicId,
      candidateDedupeKey: templateDedupeKey,
      expiryPolicy: "exclude_on_expiry",
      metadata: {
        studyPublicId: input.studyPublicId,
        candidateKind: "research_template",
        dedupeVersion: "research-template-dedupe-v1",
        reviewPolicy: "admin_approval_required",
      },
    });
    templateAsset = { id: inserted.id, public_id: inserted.public_id };
    proposed += 1;
  } else {
    duplicates += 1;
    await recordDuplicate(templateAsset, "research_template");
  }
  if (!templateAsset) throw new Error("RESEARCH_TEMPLATE_CANDIDATE_MISSING");
  await linkDerivedAsset(templateAsset.id, reportAsset.id, "research_template");

  const reportObject = input.report.content && typeof input.report.content === "object"
    && !Array.isArray(input.report.content) ? input.report.content as Record<string, unknown> : {};
  const reportTextArray = (key: "nextQuestions" | "limitations") => (
    Array.isArray(reportObject[key])
      ? reportObject[key].filter((item): item is string => typeof item === "string" && item.trim().length >= 10)
      : []
  );
  const gapCandidates = [
    ...reportTextArray("nextQuestions").slice(0, 6)
      .map((statement) => ({ kind: "next_question", statement })),
    ...reportTextArray("limitations").slice(0, 6)
      .map((statement) => ({ kind: "limitation", statement })),
  ];
  const knowledgeGapAssetPublicIds: string[] = [];
  for (const gap of gapCandidates) {
    const dedupeKey = hashContextContent(JSON.stringify({
      schemaVersion: "knowledge-gap-dedupe-v1",
      kind: gap.kind,
      statement: normalizeCandidateText(gap.statement),
    }));
    let gapAsset = await reusableCandidate("knowledge_gap", dedupeKey);
    if (!gapAsset) {
      const content = JSON.stringify({
        schemaVersion: "knowledge-gap-v1",
        kind: gap.kind,
        statement: gap.statement,
        status: "open",
        provenance: {
          studyPublicId: input.studyPublicId,
          reportPublicId: input.report.publicId,
        },
      }, null, 2);
      const inserted = await insertContextAssetRecord(transaction, {
        workspaceId: input.workspaceId,
        createdBy: input.userId,
        assetType: "knowledge_gap",
        scope: "workspace",
        studyId: null,
        title: `${gap.kind === "next_question" ? "待验证" : "证据缺口"}：${gap.statement}`.slice(0, 180),
        description: gap.kind === "next_question"
          ? "研究报告提出的后续验证问题"
          : "研究报告明确披露的限制，需要补充证据",
        sourceUri: null,
        content,
        changeNote: "Generated from completed study report",
        ingestionMethod: "study_output",
        sourceName: `Study ${input.studyPublicId}`,
        sourceMimeType: "application/json",
        evidenceKind: "mixed",
        consentStatus: "not_required",
        piiStatus: "none",
        retentionExpiresAt: candidateExpiry(180),
        reviewStatus: "pending",
        originKind: "report_knowledge_gap",
        originPublicId: `${input.report.publicId}:${gap.kind}:${dedupeKey.slice(0, 12)}`,
        candidateDedupeKey: dedupeKey,
        expiryPolicy: "exclude_on_expiry",
        metadata: {
          studyPublicId: input.studyPublicId,
          candidateKind: "knowledge_gap",
          gapKind: gap.kind,
          dedupeVersion: "knowledge-gap-dedupe-v1",
          reviewPolicy: "admin_approval_required",
        },
      });
      gapAsset = { id: inserted.id, public_id: inserted.public_id };
      proposed += 1;
    } else {
      duplicates += 1;
      await recordDuplicate(gapAsset, "knowledge_gap");
    }
    if (!gapAsset) throw new Error("KNOWLEDGE_GAP_CANDIDATE_MISSING");
    await linkDerivedAsset(gapAsset.id, reportAsset.id, "knowledge_gap");
    knowledgeGapAssetPublicIds.push(gapAsset.public_id);
  }

  return {
    proposed,
    duplicates,
    reportAssetPublicId: reportAsset.public_id,
    templateAssetPublicId: templateAsset.public_id,
    knowledgeGapAssetPublicIds,
  };
}

export async function reindexContextAsset(viewer: Viewer, publicId: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const asset = await loadManagedContextAsset(transaction, viewer, publicId, true);
    if (typeof asset === "string") return asset;
    if (asset.status === "tombstoned") return "tombstoned" as const;
    const generation = asset.index_generation + 1;
    const run = await transaction.query<{ id: string; public_id: string }>(
      `insert into context_reindex_runs (
         public_id, workspace_id, asset_id, actor_user_id, generation,
         embedding_model, embedding_version
       ) values ($1, $2, $3, $4, $5, $6, $7)
       returning id::text as id, public_id`,
      [
        createPublicId("cxj"), viewer.workspaceId, asset.id, viewer.userId, generation,
        CONTEXT_EMBEDDING_BASELINE.model, CONTEXT_EMBEDDING_BASELINE.version,
      ],
    );
    const chunks = await transaction.query<{ id: string; content: string }>(
      `select chunk.id::text as id, chunk.content
       from context_chunks chunk
       join context_asset_versions version on version.id = chunk.asset_version_id
       where version.asset_id = $1 and version.version = $2
       order by chunk.ordinal`,
      [asset.id, asset.current_version],
    );
    for (const chunk of chunks.rows) {
      const embedding = createContextEmbedding(chunk.content);
      await transaction.query(
        `update context_chunks set embedding = $2::jsonb, embedding_model = $3,
                embedding_dimensions = $4, embedding_indexed_at = now(), index_generation = $5,
                metadata = jsonb_set(metadata, '{embeddingVersion}', to_jsonb($6::text), true)
         where id = $1`,
        [
          chunk.id, JSON.stringify(embedding), CONTEXT_EMBEDDING_BASELINE.model,
          embedding.length, generation, CONTEXT_EMBEDDING_BASELINE.version,
        ],
      );
    }
    await transaction.query(
      "update context_assets set index_generation = $2, updated_at = now() where id = $1",
      [asset.id, generation],
    );
    await transaction.query(
      `update context_reindex_runs set status = 'completed', chunk_count = $2,
              finished_at = now() where id = $1`,
      [run.rows[0].id, chunks.rows.length],
    );
    return { publicId, runPublicId: run.rows[0].public_id, generation, chunkCount: chunks.rows.length };
  });
}

export async function createContextEvaluationSet(
  viewer: Viewer,
  input: z.infer<typeof contextEvaluationSetInputSchema>,
) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
  const normalized = contextEvaluationSetInputSchema.parse(input);
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const expectedPublicIds = [...new Set(normalized.cases.flatMap((item) => item.expectedChunkPublicIds))];
    const chunks = await transaction.query<{
      id: string; public_id: string; asset_public_id: string; asset_version_public_id: string; content_hash: string;
    }>(
      `select chunk.id::text as id, chunk.public_id, asset.public_id as asset_public_id,
              version.public_id as asset_version_public_id, version.content_hash
       from context_chunks chunk
       join context_asset_versions version on version.id = chunk.asset_version_id
       join context_assets asset on asset.id = version.asset_id
       where chunk.public_id = any($1::text[]) and asset.workspace_id = $2
         and asset.scope = 'workspace' and asset.current_version = version.version
         and asset.status = 'active' and asset.review_status = 'approved'
         and asset.asset_type = 'research_sample' and asset.evidence_kind = 'human'
         and asset.consent_status = 'confirmed' and asset.pii_status in ('none', 'redacted')
         and (asset.retention_expires_at is null or asset.retention_expires_at > now())`,
      [expectedPublicIds, viewer.workspaceId],
    );
    if (chunks.rows.length !== expectedPublicIds.length) return "chunk_not_authorized" as const;
    const chunksByPublicId = new Map(chunks.rows.map((chunk) => [chunk.public_id, chunk]));
    const evaluationSet = await transaction.query<{ id: string; public_id: string }>(
      `insert into context_evaluation_sets (
         public_id, workspace_id, created_by, name, description, labeling_protocol, status
       ) values ($1, $2, $3, $4, $5, $6, 'active') returning id::text as id, public_id`,
      [createPublicId("ces"), viewer.workspaceId, viewer.userId, normalized.name, normalized.description, normalized.labelingProtocol],
    );
    for (const item of normalized.cases) {
      const sourceSnapshot = item.expectedChunkPublicIds.map((publicId) => {
        const chunk = chunksByPublicId.get(publicId);
        if (!chunk) throw new Error("CONTEXT_EVALUATION_SOURCE_CHANGED");
        return {
          chunkPublicId: chunk.public_id,
          assetPublicId: chunk.asset_public_id,
          assetVersionPublicId: chunk.asset_version_public_id,
          contentHash: chunk.content_hash,
        };
      });
      const evaluationCase = await transaction.query<{ id: string }>(
        `insert into context_evaluation_cases (
           public_id, evaluation_set_id, query, filters, top_k, labeling_method,
           labeled_by, labeled_at, label_note, expected_chunk_snapshot
         ) values ($1, $2, $3, $4::jsonb, $5, 'human_annotated', $6, now(), $7, $8::jsonb)
         returning id::text as id`,
        [
          createPublicId("cec"), evaluationSet.rows[0].id, item.query,
          JSON.stringify({ assetTypes: item.assetTypes, scopes: item.scopes }), item.topK,
          viewer.userId, item.labelNote, JSON.stringify(sourceSnapshot),
        ],
      );
      for (const chunkPublicId of item.expectedChunkPublicIds) {
        await transaction.query(
          `insert into context_evaluation_relevance (evaluation_case_id, chunk_id, relevance)
           values ($1, $2, 1)`,
          [evaluationCase.rows[0].id, chunksByPublicId.get(chunkPublicId)?.id],
        );
      }
    }
    return { publicId: evaluationSet.rows[0].public_id, caseCount: normalized.cases.length };
  });
}

export async function archiveContextEvaluationSet(viewer: Viewer, evaluationSetPublicId: string) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
  const database = await getDatabase();
  const archived = await database.query<{ public_id: string }>(
    `update context_evaluation_sets
     set status = 'archived', updated_at = now()
     where public_id = $1 and workspace_id = $2 and status <> 'archived'
     returning public_id`,
    [evaluationSetPublicId, viewer.workspaceId],
  );
  return archived.rows[0] ? { publicId: archived.rows[0].public_id, status: "archived" as const } : "not_found" as const;
}

export async function listContextEvaluationSourceChunks(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return [];
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string; asset_public_id: string; asset_version_public_id: string; title: string;
    source_name: string | null; content: string; content_hash: string;
  }>(
    `select chunk.public_id, asset.public_id as asset_public_id, version.public_id as asset_version_public_id,
            asset.title, asset.source_name, chunk.content, version.content_hash
     from context_chunks chunk
     join context_asset_versions version on version.id = chunk.asset_version_id
     join context_assets asset on asset.id = version.asset_id
     where asset.workspace_id = $1 and asset.scope = 'workspace'
       and asset.current_version = version.version and asset.status = 'active'
       and asset.review_status = 'approved' and asset.asset_type = 'research_sample'
       and asset.evidence_kind = 'human' and asset.consent_status = 'confirmed'
       and asset.pii_status in ('none', 'redacted')
       and (asset.retention_expires_at is null or asset.retention_expires_at > now())
     order by asset.updated_at desc, chunk.ordinal
     limit 300`,
    [viewer.workspaceId],
  );
  return result.rows.map((chunk) => ({
    publicId: chunk.public_id,
    assetPublicId: chunk.asset_public_id,
    assetVersionPublicId: chunk.asset_version_public_id,
    title: chunk.title,
    sourceName: chunk.source_name,
    contentPreview: chunk.content,
    contentHash: chunk.content_hash,
  }));
}

export async function listContextEvaluationSets(viewer: Viewer) {
  const database = await getDatabase();
  const [sets, runs] = await Promise.all([
    database.query<{
      id: string; public_id: string; name: string; description: string; status: string; labeling_protocol: string;
      case_count: number; human_labeled_case_count: number; created_at: string; updated_at: string;
    }>(
      `select evaluation_set.id::text as id, evaluation_set.public_id, evaluation_set.name,
              evaluation_set.description, evaluation_set.status, evaluation_set.labeling_protocol,
              count(evaluation_case.id)::int as case_count,
              count(evaluation_case.id) filter (where evaluation_case.labeling_method = 'human_annotated')::int as human_labeled_case_count,
              evaluation_set.created_at::text as created_at, evaluation_set.updated_at::text as updated_at
       from context_evaluation_sets evaluation_set
       left join context_evaluation_cases evaluation_case on evaluation_case.evaluation_set_id = evaluation_set.id
       where evaluation_set.workspace_id = $1
       group by evaluation_set.id
       order by evaluation_set.updated_at desc, evaluation_set.id desc
       limit 50`,
      [viewer.workspaceId],
    ),
    database.query<{
      public_id: string; evaluation_set_id: string; strategy: string; embedding_model: string | null;
      embedding_version: string | null; status: string; case_count: number;
      metrics: Record<string, unknown> | string; error_message: string | null;
      started_at: string; finished_at: string | null;
    }>(
      `select public_id, evaluation_set_id::text as evaluation_set_id, strategy,
              embedding_model, embedding_version, status, case_count, metrics, error_message,
              started_at::text as started_at, finished_at::text as finished_at
       from context_evaluation_runs
       where workspace_id = $1
       order by started_at desc, id desc
       limit 200`,
      [viewer.workspaceId],
    ),
  ]);
  const runsBySet = new Map<string, typeof runs.rows>();
  for (const run of runs.rows) {
    const current = runsBySet.get(run.evaluation_set_id) ?? [];
    if (current.length < 10) current.push(run);
    runsBySet.set(run.evaluation_set_id, current);
  }
  return sets.rows.map((evaluationSet) => ({
    publicId: evaluationSet.public_id,
    name: evaluationSet.name,
    description: evaluationSet.description,
    status: evaluationSet.status,
    labelingProtocol: evaluationSet.labeling_protocol,
    caseCount: evaluationSet.case_count,
    humanLabeledCaseCount: evaluationSet.human_labeled_case_count,
    createdAt: evaluationSet.created_at,
    updatedAt: evaluationSet.updated_at,
    runs: (runsBySet.get(evaluationSet.id) ?? []).map((run) => ({
      publicId: run.public_id,
      strategy: run.strategy,
      embeddingModel: run.embedding_model,
      embeddingVersion: run.embedding_version,
      status: run.status,
      caseCount: run.case_count,
      metrics: typeof run.metrics === "string" ? JSON.parse(run.metrics) as Record<string, unknown> : run.metrics,
      errorMessage: run.error_message,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
    })),
  }));
}

type ContextRetrievalCandidate = {
  chunk_id: string;
  chunk_public_id: string;
  content: string;
  asset_public_id: string;
  version_public_id: string;
  version: number;
  asset_type: string;
  scope: ContextScope;
  title: string;
  source_uri: string | null;
  embedding: number[] | string | null;
  full_text_score: number;
  asset_study_id: string | null;
  memory_kind: ContextMemoryKind | null;
  memory_subject_type: string | null;
  memory_subject_user_id: string | null;
  memory_subject_public_id: string | null;
  memory_valid_from: string | null;
  memory_valid_until: string | null;
  policy_version: number | null;
  policy_allowed_purposes: ContextPurpose[] | string | null;
};

type RankedContextCandidate = {
  row: ContextRetrievalCandidate;
  score: number;
  reasons: string[];
};

async function loadContextRetrievalCandidates(
  database: Queryable,
  input: {
    workspaceId: string;
    userId: string | null;
    query: string;
    assetTypes?: string[];
    scopes?: ContextScope[];
    studyId?: string;
    purpose?: ContextPurpose;
  },
) {
  const result = await database.query<ContextRetrievalCandidate>(
    `select chunk.id::text as chunk_id, chunk.public_id as chunk_public_id, chunk.content,
            asset.public_id as asset_public_id, version.public_id as version_public_id,
            version.version, asset.asset_type, asset.scope, asset.title, asset.source_uri,
            asset.study_id::text as asset_study_id, chunk.embedding,
            binding.memory_kind, binding.subject_type as memory_subject_type,
            binding.subject_user_id::text as memory_subject_user_id,
            binding.subject_public_id as memory_subject_public_id,
            binding.valid_from::text as memory_valid_from,
            binding.valid_until::text as memory_valid_until,
            policy.version as policy_version, policy.allowed_purposes as policy_allowed_purposes,
            ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', $6)) as full_text_score
     from context_chunks chunk
     join context_asset_versions version on version.id = chunk.asset_version_id
     join context_assets asset on asset.id = version.asset_id and asset.current_version = version.version
     left join context_memory_bindings binding on binding.asset_id = asset.id
     left join context_memory_policies policy
       on policy.workspace_id = asset.workspace_id and policy.memory_kind = binding.memory_kind
      and policy.status = 'active'
     where asset.workspace_id = $1 and asset.status = 'active'
       and (asset.retention_expires_at is null or asset.retention_expires_at > now())
       and (asset.scope <> 'user' or asset.created_by = $2)
       and (cardinality($3::text[]) = 0 or asset.asset_type = any($3::text[]))
       and (cardinality($4::text[]) = 0 or asset.scope = any($4::text[]))
       and (asset.scope <> 'study' or asset.study_id = $5)
       and (
         asset.asset_type <> 'persona'
         or asset.origin_kind <> 'study_persona'
         or exists (
           select 1 from study_personas persona
           where persona.workspace_id = asset.workspace_id
             and persona.public_id = asset.origin_public_id
             and persona.retention_status = 'retained'
             and (persona.valid_until is null or persona.valid_until > now())
         )
       )
       and (
         asset.asset_type not in ('core_memory', 'working_memory', 'team_memory')
         or (
           binding.memory_kind = case asset.asset_type
             when 'core_memory' then 'core'
             when 'working_memory' then 'working'
             when 'team_memory' then 'team'
           end
           and policy.id is not null
           and $7 = any(policy.allowed_purposes)
           and binding.valid_from <= now()
           and (binding.valid_until is null or binding.valid_until > now())
           and (
             (binding.memory_kind = 'core' and binding.subject_type = 'user' and binding.subject_user_id = $2)
             or (binding.memory_kind = 'team' and binding.subject_type = 'workspace')
             or (
               binding.memory_kind = 'working'
               and (
                 (binding.subject_type = 'user' and binding.subject_user_id = $2)
                 or (binding.subject_type = 'study' and asset.study_id = $5)
               )
             )
           )
         )
       )
     order by ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', $6)) desc,
              asset.updated_at desc, chunk.ordinal
     limit 600`,
    [input.workspaceId, input.userId, input.assetTypes ?? [], input.scopes ?? [], input.studyId ?? null, input.query, input.purpose ?? "general"],
  );
  return result.rows;
}

function emptyContextPolicyDecision(purpose: ContextPurpose): ContextPolicyDecision {
  return {
    version: "memory-policy-v1",
    purpose,
    evaluatedMemoryChunks: 0,
    allowedMemoryChunks: 0,
    deniedMemoryChunks: 0,
    denialReasons: {},
    policyVersions: { core: null, working: null, team: null },
  };
}

function parseAllowedPurposes(value: ContextPurpose[] | string | null) {
  if (!value) return [];
  return typeof value === "string" ? JSON.parse(value) as ContextPurpose[] : value;
}

function applyContextMemoryPolicy(
  candidates: ContextRetrievalCandidate[],
  input: { userId: string | null; studyId?: string; purpose: ContextPurpose },
) {
  const decision = emptyContextPolicyDecision(input.purpose);
  const allowed: ContextRetrievalCandidate[] = [];
  const now = Date.now();
  for (const candidate of candidates) {
    const expectedKind = memoryKindForAssetType(candidate.asset_type);
    if (!expectedKind) {
      allowed.push(candidate);
      continue;
    }
    decision.evaluatedMemoryChunks += 1;
    const reasons: string[] = [];
    if (!candidate.memory_kind || candidate.memory_kind !== expectedKind) reasons.push("memory_binding_missing");
    if (!candidate.policy_version) reasons.push("active_policy_missing");
    if (candidate.policy_version) {
      decision.policyVersions[expectedKind] = Math.max(
        decision.policyVersions[expectedKind] ?? 0,
        candidate.policy_version,
      );
    }
    if (!parseAllowedPurposes(candidate.policy_allowed_purposes).includes(input.purpose)) {
      reasons.push("purpose_not_allowed");
    }
    if (candidate.memory_valid_from && new Date(candidate.memory_valid_from).getTime() > now) {
      reasons.push("memory_not_yet_valid");
    }
    if (candidate.memory_valid_until && new Date(candidate.memory_valid_until).getTime() <= now) {
      reasons.push("memory_expired");
    }
    if (candidate.memory_subject_type === "user" && candidate.memory_subject_user_id !== input.userId) {
      reasons.push("user_subject_mismatch");
    }
    if (candidate.memory_subject_type === "study"
      && (!input.studyId || candidate.asset_study_id !== input.studyId)) {
      reasons.push("study_subject_mismatch");
    }
    if (reasons.length) {
      decision.deniedMemoryChunks += 1;
      for (const reason of [...new Set(reasons)]) {
        decision.denialReasons[reason] = (decision.denialReasons[reason] ?? 0) + 1;
      }
      continue;
    }
    decision.allowedMemoryChunks += 1;
    allowed.push(candidate);
  }
  return { candidates: allowed, decision };
}

async function loadContextPolicyDecision(
  database: Queryable,
  input: {
    workspaceId: string; userId: string | null; purpose: ContextPurpose;
    assetTypes?: string[]; scopes?: ContextScope[]; studyId?: string;
  },
) {
  const result = await database.query<{
    evaluated: number; allowed: number; binding_missing: number; active_policy_missing: number;
    purpose_not_allowed: number; memory_not_yet_valid: number; memory_expired: number;
    subject_scope_mismatch: number; core_version: number | null;
    working_version: number | null; team_version: number | null;
  }>(
    `select
       count(*)::int as evaluated,
       count(*) filter (where
         binding.memory_kind = case asset.asset_type
           when 'core_memory' then 'core' when 'working_memory' then 'working' when 'team_memory' then 'team'
         end
         and policy.id is not null and $6 = any(policy.allowed_purposes)
         and binding.valid_from <= now() and (binding.valid_until is null or binding.valid_until > now())
         and (
           (binding.memory_kind = 'core' and binding.subject_type = 'user' and binding.subject_user_id = $2)
           or (binding.memory_kind = 'team' and binding.subject_type = 'workspace')
           or (binding.memory_kind = 'working' and (
             (binding.subject_type = 'user' and binding.subject_user_id = $2)
             or (binding.subject_type = 'study' and asset.study_id = $5)
           ))
         )
       )::int as allowed,
       count(*) filter (where binding.id is null or binding.memory_kind is distinct from case asset.asset_type
         when 'core_memory' then 'core' when 'working_memory' then 'working' when 'team_memory' then 'team' end)::int as binding_missing,
       count(*) filter (where binding.id is not null and policy.id is null)::int as active_policy_missing,
       count(*) filter (where policy.id is not null and not ($6 = any(policy.allowed_purposes)))::int as purpose_not_allowed,
       count(*) filter (where binding.valid_from > now())::int as memory_not_yet_valid,
       count(*) filter (where binding.valid_until is not null and binding.valid_until <= now())::int as memory_expired,
       count(*) filter (where binding.id is not null and not (
         (binding.memory_kind = 'core' and binding.subject_type = 'user' and binding.subject_user_id = $2)
         or (binding.memory_kind = 'team' and binding.subject_type = 'workspace')
         or (binding.memory_kind = 'working' and (
           (binding.subject_type = 'user' and binding.subject_user_id = $2)
           or (binding.subject_type = 'study' and asset.study_id = $5)
         ))
       ))::int as subject_scope_mismatch,
       max(policy.version) filter (where binding.memory_kind = 'core')::int as core_version,
       max(policy.version) filter (where binding.memory_kind = 'working')::int as working_version,
       max(policy.version) filter (where binding.memory_kind = 'team')::int as team_version
     from context_chunks chunk
     join context_asset_versions version on version.id = chunk.asset_version_id
     join context_assets asset on asset.id = version.asset_id and asset.current_version = version.version
     left join context_memory_bindings binding on binding.asset_id = asset.id
     left join context_memory_policies policy
       on policy.workspace_id = asset.workspace_id and policy.memory_kind = binding.memory_kind and policy.status = 'active'
     where asset.workspace_id = $1 and asset.status = 'active'
       and asset.asset_type in ('core_memory', 'working_memory', 'team_memory')
       and (asset.retention_expires_at is null or asset.retention_expires_at > now())
       and (asset.scope <> 'user' or asset.created_by = $2)
       and (cardinality($3::text[]) = 0 or asset.asset_type = any($3::text[]))
       and (cardinality($4::text[]) = 0 or asset.scope = any($4::text[]))
       and (asset.scope <> 'study' or asset.study_id = $5)`,
    [input.workspaceId, input.userId, input.assetTypes ?? [], input.scopes ?? [], input.studyId ?? null, input.purpose],
  );
  const row = result.rows[0];
  const decision = emptyContextPolicyDecision(input.purpose);
  if (!row) return decision;
  decision.evaluatedMemoryChunks = row.evaluated;
  decision.allowedMemoryChunks = row.allowed;
  decision.deniedMemoryChunks = row.evaluated - row.allowed;
  decision.policyVersions = { core: row.core_version, working: row.working_version, team: row.team_version };
  for (const [reason, count] of Object.entries({
    memory_binding_missing: row.binding_missing,
    active_policy_missing: row.active_policy_missing,
    purpose_not_allowed: row.purpose_not_allowed,
    memory_not_yet_valid: row.memory_not_yet_valid,
    memory_expired: row.memory_expired,
    subject_scope_mismatch: row.subject_scope_mismatch,
  })) {
    if (count > 0) decision.denialReasons[reason] = count;
  }
  return decision;
}

function storedContextEmbedding(candidate: ContextRetrievalCandidate) {
  return typeof candidate.embedding === "string"
    ? JSON.parse(candidate.embedding) as number[]
    : candidate.embedding ?? createContextEmbedding(candidate.content);
}

function rankContextRetrievalCandidates(input: {
  query: string;
  queryEmbedding: number[];
  candidates: ContextRetrievalCandidate[];
  candidateEmbeddings?: Map<string, number[]>;
  semanticReason: string;
  limit: number;
}): RankedContextCandidate[] {
  const terms = queryTerms(input.query);
  return input.candidates
    .map((row) => {
      const lexical = scoreCandidate(input.query, terms, row);
      const embedding = input.candidateEmbeddings?.get(row.chunk_id) ?? storedContextEmbedding(row);
      const semanticScore = Math.max(0, cosineSimilarity(input.queryEmbedding, embedding));
      const lexicalScore = Math.max(Number(row.full_text_score), lexical.score / (lexical.score + 12));
      const effectiveSemanticScore = semanticScore >= 0.08 ? semanticScore : 0;
      const reasons = [...lexical.reasons];
      if (Number(row.full_text_score) > 0) reasons.push("full_text");
      if (effectiveSemanticScore > 0) reasons.push(input.semanticReason);
      return { row, score: lexicalScore * 0.7 + effectiveSemanticScore * 0.3, reasons };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit);
}

function summarizeContextEvaluationScores(scores: Array<{ precision: number; recall: number; reciprocalRank: number }>): ContextEvaluationMetrics {
  return {
    precisionAtK: scores.length ? scores.reduce((sum, item) => sum + item.precision, 0) / scores.length : 0,
    recallAtK: scores.length ? scores.reduce((sum, item) => sum + item.recall, 0) / scores.length : 0,
    meanReciprocalRank: scores.length ? scores.reduce((sum, item) => sum + item.reciprocalRank, 0) / scores.length : 0,
  };
}

function scoreContextEvaluationResult(retrieved: string[], expected: string[]) {
  const relevantRetrieved = retrieved.filter((chunkPublicId) => expected.includes(chunkPublicId)).length;
  const firstRelevant = retrieved.findIndex((chunkPublicId) => expected.includes(chunkPublicId));
  return {
    precision: retrieved.length ? relevantRetrieved / retrieved.length : 0,
    recall: expected.length ? relevantRetrieved / expected.length : 0,
    reciprocalRank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
  };
}

export async function runContextEvaluation(
  viewer: Viewer,
  evaluationSetPublicId: string,
  input: z.infer<typeof contextEmbeddingEvaluationInputSchema> = { provider: "baseline" },
) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
  const database = await getDatabase();
  const target = resolveContextEmbeddingEvaluationTarget(input);
  if (target.provider === "openai" && !getContextEmbeddingProviderStatus().openai.configured) {
    return "embedding_endpoint_not_configured" as const;
  }
  const evaluationSet = await database.query<{ id: string }>(
    `select id::text as id from context_evaluation_sets
     where public_id = $1 and workspace_id = $2 and status = 'active' limit 1`,
    [evaluationSetPublicId, viewer.workspaceId],
  );
  if (!evaluationSet.rows[0]) return "not_found" as const;
  const humanLabeledCases = await database.query<{ count: number }>(
    `select count(*)::int as count from context_evaluation_cases
     where evaluation_set_id = $1 and labeling_method = 'human_annotated'`,
    [evaluationSet.rows[0].id],
  );
  if (humanLabeledCases.rows[0].count < 20) return "insufficient_human_labels" as const;
  const run = await database.query<{ id: string; public_id: string }>(
    `insert into context_evaluation_runs (
       public_id, evaluation_set_id, workspace_id, created_by, strategy,
       embedding_model, embedding_version
     ) values ($1, $2, $3, $4, 'hybrid_embedding_eval_v1', $5, $6)
     returning id::text as id, public_id`,
    [
      createPublicId("cer"), evaluationSet.rows[0].id, viewer.workspaceId, viewer.userId,
      target.model, target.version,
    ],
  );
  const cases = await database.query<{
    id: string; query: string; filters: Record<string, unknown> | string; top_k: number;
    expected: string[] | string;
  }>(
    `select evaluation_case.id::text as id, evaluation_case.query, evaluation_case.filters,
            evaluation_case.top_k,
            coalesce(jsonb_agg(chunk.public_id order by relevance.relevance desc, chunk.id)
              filter (where chunk.id is not null), '[]'::jsonb) as expected
     from context_evaluation_cases evaluation_case
     left join context_evaluation_relevance relevance on relevance.evaluation_case_id = evaluation_case.id
     left join context_chunks chunk on chunk.id = relevance.chunk_id
     where evaluation_case.evaluation_set_id = $1
     group by evaluation_case.id order by evaluation_case.id`,
    [evaluationSet.rows[0].id],
  );
  try {
    const materializedCases = await Promise.all(cases.rows.map(async (item) => {
      const filters = typeof item.filters === "string" ? JSON.parse(item.filters) as Record<string, unknown> : item.filters;
      const expected = typeof item.expected === "string" ? JSON.parse(item.expected) as string[] : item.expected;
      const loadedCandidates = await loadContextRetrievalCandidates(database, {
        workspaceId: viewer.workspaceId,
        userId: viewer.userId,
        query: item.query,
        assetTypes: Array.isArray(filters.assetTypes) ? filters.assetTypes.map(String) : [],
        scopes: Array.isArray(filters.scopes) ? filters.scopes as ContextScope[] : [],
        purpose: "general",
      });
      const { candidates } = applyContextMemoryPolicy(loadedCandidates, {
        userId: viewer.userId,
        purpose: "general",
      });
      return { id: item.id, query: item.query, topK: item.top_k, expected, candidates };
    }));
    const embeddingTexts = [...new Set(materializedCases.flatMap((item) => [
      item.query,
      ...item.candidates.map((candidate) => candidate.content),
    ]))];
    if (target.provider === "openai" && embeddingTexts.length > 5_000) {
      throw new Error("CONTEXT_EMBEDDING_EVALUATION_INPUT_LIMIT_EXCEEDED");
    }
    const openAIEmbeddingResult = target.provider === "openai"
      ? await createProductionEmbeddings(embeddingTexts, target.model)
      : null;
    const candidateScores: Array<{ precision: number; recall: number; reciprocalRank: number }> = [];
    const baselineScores: Array<{ precision: number; recall: number; reciprocalRank: number }> = [];
    for (const item of materializedCases) {
      const baselineRanked = rankContextRetrievalCandidates({
        query: item.query,
        queryEmbedding: createContextEmbedding(item.query),
        candidates: item.candidates,
        semanticReason: "semantic_ngram",
        limit: item.topK,
      });
      const baselineRetrieved = baselineRanked.map((candidate) => candidate.row.chunk_public_id);
      baselineScores.push(scoreContextEvaluationResult(baselineRetrieved, item.expected));
      const candidateRanked = target.provider === "baseline"
        ? baselineRanked
        : rankContextRetrievalCandidates({
          query: item.query,
          queryEmbedding: openAIEmbeddingResult?.vectors.get(item.query) ?? [],
          candidates: item.candidates,
          candidateEmbeddings: new Map(item.candidates.map((candidate) => [
            candidate.chunk_id,
            openAIEmbeddingResult?.vectors.get(candidate.content) ?? [],
          ])),
          semanticReason: "semantic_openai",
          limit: item.topK,
        });
      const retrieved = candidateRanked.map((candidate) => candidate.row.chunk_public_id);
      const result = scoreContextEvaluationResult(retrieved, item.expected);
      candidateScores.push(result);
      await database.query(
        `insert into context_evaluation_results (
           evaluation_run_id, evaluation_case_id, retrieved_chunk_ids, expected_chunk_ids,
           precision_at_k, recall_at_k, reciprocal_rank
         ) values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)`,
        [run.rows[0].id, item.id, JSON.stringify(retrieved), JSON.stringify(item.expected), result.precision, result.recall, result.reciprocalRank],
      );
    }
    const metrics = summarizeContextEvaluationScores(candidateScores);
    const baselineMetrics = summarizeContextEvaluationScores(baselineScores);
    const deltas = {
      precisionAtK: metrics.precisionAtK - baselineMetrics.precisionAtK,
      recallAtK: metrics.recallAtK - baselineMetrics.recallAtK,
      meanReciprocalRank: metrics.meanReciprocalRank - baselineMetrics.meanReciprocalRank,
    };
    const gateReasons: string[] = [];
    if (target.provider === "baseline") gateReasons.push("baseline 仅用于可重复对照，不能作为生产 embedding 候选");
    if (target.provider !== "baseline" && cases.rows.length < CONTEXT_PRODUCTION_EMBEDDING_GATE.minimumCaseCount) {
      gateReasons.push(`评估 case 少于 ${CONTEXT_PRODUCTION_EMBEDDING_GATE.minimumCaseCount}`);
    }
    if (target.provider !== "baseline" && deltas.meanReciprocalRank < CONTEXT_PRODUCTION_EMBEDDING_GATE.minimumMeanReciprocalRankGain) {
      gateReasons.push(`MRR 提升未达到 ${CONTEXT_PRODUCTION_EMBEDDING_GATE.minimumMeanReciprocalRankGain}`);
    }
    if (target.provider !== "baseline" && CONTEXT_PRODUCTION_EMBEDDING_GATE.requireNonDecreasingPrecisionAtK && deltas.precisionAtK < 0) {
      gateReasons.push("Precision@K 低于基线");
    }
    if (target.provider !== "baseline" && CONTEXT_PRODUCTION_EMBEDDING_GATE.requireNonDecreasingRecallAtK && deltas.recallAtK < 0) {
      gateReasons.push("Recall@K 低于基线");
    }
    const eligibleForIndexTrial = target.provider !== "baseline" && gateReasons.length === 0;
    const persistedMetrics = {
      ...metrics,
      baseline: baselineMetrics,
      delta: deltas,
      target,
      providerTelemetry: openAIEmbeddingResult?.telemetry ?? {
        requestCount: 0,
        inputCount: embeddingTexts.length,
        dimensions: CONTEXT_EMBEDDING_BASELINE.dimensions,
        promptTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
      },
      gate: {
        eligibleForIndexTrial,
        reasons: gateReasons,
        threshold: CONTEXT_PRODUCTION_EMBEDDING_GATE,
      },
    };
    await database.query(
      `update context_evaluation_runs set status = 'completed', case_count = $2,
              metrics = $3::jsonb, finished_at = now() where id = $1`,
      [run.rows[0].id, cases.rows.length, JSON.stringify(persistedMetrics)],
    );
    return {
      publicId: run.rows[0].public_id,
      caseCount: cases.rows.length,
      metrics,
      baselineMetrics,
      deltas,
      target,
      providerTelemetry: persistedMetrics.providerTelemetry,
      gate: persistedMetrics.gate,
    };
  } catch (error) {
    await database.query(
      `update context_evaluation_runs set status = 'failed', error_message = $2,
              finished_at = now() where id = $1`,
      [run.rows[0].id, error instanceof Error ? error.message.slice(0, 500) : "unknown"],
    );
    throw error;
  }
}

export async function retrieveContextWithQueryable(database: Queryable, input: {
  workspaceId: string;
  userId: string | null;
  query: string;
  assetTypes?: string[];
  scopes?: ContextScope[];
  limit?: number;
  studyId?: string;
  runId?: string;
  interviewSessionId?: string;
  audit?: boolean;
  purpose?: ContextPurpose;
  reuseExistingRunSnapshot?: boolean;
}): Promise<ContextSnapshot> {
  const purpose = input.purpose ?? "general";
  if (input.runId && input.audit !== false && input.reuseExistingRunSnapshot !== false) {
    const existing = await loadRunContextSnapshot(database, input.runId, input.workspaceId);
    if (existing !== null) return existing;
  }
  if (input.interviewSessionId && input.audit !== false) {
    const existing = await loadInterviewContextSnapshot(database, input.interviewSessionId, input.workspaceId);
    if (existing !== null) return existing;
  }
  const [loadedCandidates, policyDecision] = await Promise.all([
    loadContextRetrievalCandidates(database, { ...input, purpose }),
    loadContextPolicyDecision(database, { ...input, purpose }),
  ]);
  const { candidates } = applyContextMemoryPolicy(loadedCandidates, {
    userId: input.userId,
    studyId: input.studyId,
    purpose,
  });
  const ranked = rankContextRetrievalCandidates({
    query: input.query,
    queryEmbedding: createContextEmbedding(input.query),
    candidates,
    semanticReason: "semantic_ngram",
    limit: input.limit ?? 8,
  });
  const citations: ContextCitation[] = ranked.map(({ row, score, reasons }) => ({
    chunkPublicId: row.chunk_public_id,
    assetPublicId: row.asset_public_id,
    assetVersionPublicId: row.version_public_id,
    assetType: row.asset_type,
    scope: row.scope,
    title: row.title,
    sourceUri: row.source_uri,
    version: row.version,
    content: row.content,
    score,
    reasons,
    memoryKind: memoryKindForAssetType(row.asset_type),
  }));
  if (input.audit === false) {
    return {
      retrievalId: null,
      retrievalPublicId: null,
      retrievedAt: null,
      strategy: "hybrid_v1",
      query: input.query,
      purpose,
      policyVersion: "memory-policy-v1",
      policyDecision,
      citations,
    };
  }
  const retrieval = await database.query<{ id: string; public_id: string }>(
      `insert into context_retrievals (
         public_id, workspace_id, created_by, study_id, run_id, interview_session_id,
         query, strategy, filters, embedding_model, embedding_version, lexical_weight, semantic_weight,
         purpose, policy_version, policy_decision
       ) values ($1, $2, $3, $4, $5, $6, $7, 'hybrid_v1', $8::jsonb, $9, $10, 0.7, 0.3,
                 $11, 'memory-policy-v1', $12::jsonb)
       on conflict do nothing
       returning id::text as id, public_id`,
      [
        createPublicId("cxr"), input.workspaceId, input.userId, input.studyId ?? null, input.runId ?? null,
        input.interviewSessionId ?? null, input.query,
        JSON.stringify({ assetTypes: input.assetTypes ?? [], scopes: input.scopes ?? [] }),
        CONTEXT_EMBEDDING_BASELINE.model, CONTEXT_EMBEDDING_BASELINE.version,
        purpose, JSON.stringify(policyDecision),
      ],
    );
  if (!retrieval.rows[0]) {
    const existing = input.runId
      ? await loadRunContextSnapshot(database, input.runId, input.workspaceId)
      : input.interviewSessionId
        ? await loadInterviewContextSnapshot(database, input.interviewSessionId, input.workspaceId)
        : null;
    if (existing !== null) return existing;
    throw new Error("CONTEXT_RETRIEVAL_CONFLICT");
  }
  for (const [index, item] of ranked.entries()) {
    await database.query(
      `insert into context_retrieval_items (retrieval_id, chunk_id, rank, score, reasons)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [retrieval.rows[0].id, item.row.chunk_id, index + 1, item.score, JSON.stringify(item.reasons)],
    );
  }
  return {
    retrievalId: retrieval.rows[0].id,
    retrievalPublicId: retrieval.rows[0].public_id,
    retrievedAt: new Date().toISOString(),
    strategy: "hybrid_v1" as const,
    query: input.query,
    purpose,
    policyVersion: "memory-policy-v1" as const,
    policyDecision,
    citations,
  };
}

export async function retrieveContext(input: {
  workspaceId: string;
  userId: string | null;
  query: string;
  assetTypes?: string[];
  scopes?: ContextScope[];
  limit?: number;
  studyId?: string;
  runId?: string;
  interviewSessionId?: string;
  audit?: boolean;
  purpose?: ContextPurpose;
  reuseExistingRunSnapshot?: boolean;
}): Promise<ContextSnapshot> {
  const database = await getDatabase();
  if (input.audit === false) return retrieveContextWithQueryable(database, input);
  return database.transaction((transaction) => retrieveContextWithQueryable(transaction, input));
}

export async function retrieveContextForReasoningDecision(queryable: Queryable, input: {
  workspaceId: string;
  userId: string | null;
  studyId: string;
  runId: string;
  taskId: string | null;
  reasoningDecisionPublicId: string;
  triggerType: "insufficient" | "conflicted" | "stale";
  triggerReason: string;
  query: string;
  assetTypes?: string[];
  scopes?: ContextScope[];
  limit?: number;
  purpose?: ContextPurpose;
}) {
  const existing = await queryable.query<{ retrieval_id: string }>(
    `select binding.retrieval_id::text as retrieval_id
     from context_retrieval_bindings binding
     join reasoning_decisions decision on decision.id = binding.reasoning_decision_id
     where decision.public_id = $1 and binding.workspace_id = $2`,
    [input.reasoningDecisionPublicId, input.workspaceId],
  );
  if (existing.rows[0]) {
    const snapshot = await loadContextSnapshotByRetrievalId(queryable, existing.rows[0].retrieval_id, input.workspaceId);
    if (snapshot) return snapshot;
    throw new Error("DYNAMIC_CONTEXT_RETRIEVAL_MISSING");
  }
  const decision = await queryable.query<{ id: string }>(
    `select id::text as id from reasoning_decisions
     where public_id = $1 and workspace_id = $2 and study_id = $3 and run_id = $4`,
    [input.reasoningDecisionPublicId, input.workspaceId, input.studyId, input.runId],
  );
  if (!decision.rows[0]) throw new Error("REASONING_DECISION_NOT_FOUND");
  const snapshot = await retrieveContextWithQueryable(queryable, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    studyId: input.studyId,
    runId: input.runId,
    query: input.query,
    assetTypes: input.assetTypes,
    scopes: input.scopes,
    limit: input.limit,
    purpose: input.purpose ?? "research_execution",
    reuseExistingRunSnapshot: false,
  });
  if (!snapshot.retrievalId) throw new Error("DYNAMIC_CONTEXT_RETRIEVAL_NOT_AUDITED");
  const binding = await queryable.query<{ retrieval_id: string }>(
    `insert into context_retrieval_bindings (
       public_id, workspace_id, study_id, run_id, task_id, reasoning_decision_id,
       retrieval_id, trigger_type, trigger_reason, request_snapshot
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict (reasoning_decision_id) do nothing
     returning retrieval_id::text as retrieval_id`,
    [
      createPublicId("crb"), input.workspaceId, input.studyId, input.runId, input.taskId,
      decision.rows[0].id, snapshot.retrievalId, input.triggerType, input.triggerReason,
      JSON.stringify({ query: input.query, assetTypes: input.assetTypes ?? [], scopes: input.scopes ?? [], purpose: input.purpose ?? "research_execution" }),
    ],
  );
  if (binding.rows[0]) return snapshot;
  const concurrent = await queryable.query<{ retrieval_id: string }>(
    `select retrieval_id::text as retrieval_id from context_retrieval_bindings
     where reasoning_decision_id = $1`,
    [decision.rows[0].id],
  );
  const concurrentSnapshot = concurrent.rows[0]
    ? await loadContextSnapshotByRetrievalId(queryable, concurrent.rows[0].retrieval_id, input.workspaceId)
    : null;
  if (concurrentSnapshot) return concurrentSnapshot;
  throw new Error("DYNAMIC_CONTEXT_RETRIEVAL_BINDING_CONFLICT");
}

async function loadInterviewContextSnapshot(
  database: Queryable,
  interviewSessionId: string,
  workspaceId: string,
) {
  return loadContextSnapshot(database, "interview_session_id", interviewSessionId, workspaceId);
}

async function loadRunContextSnapshot(
  database: Queryable,
  runId: string,
  workspaceId: string,
): Promise<ContextSnapshot | null> {
  const refreshed = await database.query<{ retrieval_id: string }>(
    `select binding.retrieval_id::text as retrieval_id
     from context_retrieval_bindings binding
     where binding.run_id = $1 and binding.workspace_id = $2
     order by binding.created_at desc, binding.id desc limit 1`,
    [runId, workspaceId],
  );
  if (refreshed.rows[0]) {
    const snapshot = await loadContextSnapshotByRetrievalId(database, refreshed.rows[0].retrieval_id, workspaceId);
    if (snapshot) return snapshot;
  }
  return loadContextSnapshot(database, "run_id", runId, workspaceId);
}

async function loadContextSnapshotByRetrievalId(
  database: Queryable,
  retrievalId: string,
  workspaceId: string,
): Promise<ContextSnapshot | null> {
  return loadContextSnapshot(database, "id", retrievalId, workspaceId);
}

async function loadContextSnapshot(
  database: Queryable,
  binding: "run_id" | "interview_session_id" | "id",
  bindingId: string,
  workspaceId: string,
): Promise<ContextSnapshot | null> {
  const retrieval = await database.query<{
    id: string; public_id: string; created_at: string; query: string; strategy: "lexical_metadata_v1" | "hybrid_v1";
    purpose: ContextPurpose; policy_version: string; policy_decision: Partial<ContextPolicyDecision> | string;
  }>(
    `select id::text as id, public_id, created_at::text as created_at, query, strategy, purpose, policy_version, policy_decision
     from context_retrievals where ${binding} = $1 and workspace_id = $2
     order by created_at, id limit 1`,
    [bindingId, workspaceId],
  );
  const record = retrieval.rows[0];
  if (!record) return null;
  const items = await database.query<{
    chunk_public_id: string; asset_public_id: string; version_public_id: string;
    asset_type: string; scope: ContextScope; title: string; source_uri: string | null;
    version: number; content: string; score: number; reasons: string[] | string;
    memory_kind: ContextMemoryKind | null;
  }>(
    `select chunk.public_id as chunk_public_id, asset.public_id as asset_public_id,
            asset_version.public_id as version_public_id, asset.asset_type, asset.scope,
            asset.title, asset.source_uri, asset_version.version, chunk.content,
            item.score, item.reasons, binding.memory_kind
     from context_retrieval_items item
     join context_chunks chunk on chunk.id = item.chunk_id
     join context_asset_versions asset_version on asset_version.id = chunk.asset_version_id
     join context_assets asset on asset.id = asset_version.asset_id
     left join context_memory_bindings binding on binding.asset_id = asset.id
     where item.retrieval_id = $1 order by item.rank`,
    [record.id],
  );
  const storedDecision = typeof record.policy_decision === "string"
    ? JSON.parse(record.policy_decision) as Partial<ContextPolicyDecision>
    : record.policy_decision;
  const defaults = emptyContextPolicyDecision(record.purpose);
  const policyDecision: ContextPolicyDecision = {
    ...defaults,
    ...storedDecision,
    version: "memory-policy-v1",
    purpose: record.purpose,
    denialReasons: storedDecision.denialReasons ?? {},
    policyVersions: { ...defaults.policyVersions, ...(storedDecision.policyVersions ?? {}) },
  };
  return {
    retrievalId: record.id,
    retrievalPublicId: record.public_id,
    retrievedAt: record.created_at,
    strategy: record.strategy,
    query: record.query,
    purpose: record.purpose,
    policyVersion: "memory-policy-v1",
    policyDecision,
    citations: items.rows.map((item) => ({
      chunkPublicId: item.chunk_public_id,
      assetPublicId: item.asset_public_id,
      assetVersionPublicId: item.version_public_id,
      assetType: item.asset_type,
      scope: item.scope,
      title: item.title,
      sourceUri: item.source_uri,
      version: item.version,
      content: item.content,
      score: item.score,
      reasons: typeof item.reasons === "string" ? JSON.parse(item.reasons) as string[] : item.reasons,
      memoryKind: item.memory_kind,
    })),
  };
}

export function formatContextForPrompt(snapshot: ContextSnapshot, maxCharacters = 6000) {
  if (!snapshot.citations.length) return "";
  let remaining = maxCharacters;
  const entries: string[] = [];
  for (const citation of snapshot.citations) {
    const entry = `[Context: ${citation.title} v${citation.version} / ${citation.chunkPublicId}]\n${citation.content}`;
    if (remaining <= 0) break;
    entries.push(entry.slice(0, remaining));
    remaining -= entry.length;
  }
  return entries.join("\n\n");
}
