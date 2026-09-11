import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Database, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import {
  formatContextForPrompt,
  proposeStudyContextCandidates,
  retrieveContext,
  retrieveContextForReasoningDecision,
  type ContextSnapshot,
} from "@/lib/context-system";
import {
  buildProviderPersonaPanel,
  describeOpenAIError,
  generateProviderResearchInterviews,
  getProviderStageStatus,
  judgeProviderResearchReport,
  researchPublicWeb,
  reviseProviderResearchReport,
  runProviderAudienceCall,
  runProviderDiscussionChat,
  synthesizeProviderResearchReport,
  withProviderRoute,
  type ProviderDeepResearchValidation,
  type ProviderResearchDiscussion,
  type ProviderResearchInterviews,
  type ProviderResearchSources,
  type ProviderStage,
  type ResearchReport,
} from "@/lib/openai-provider";
import { finishProviderRouteDecision, resolveProviderRoute } from "@/lib/platform-control";
import { getBlueskyPublicConnectorStatus } from "@/lib/bluesky-social-connector";
import { materializeReportEvidenceGraph } from "@/lib/evidence-graph";
import { groundStudyPersonasFromEvidence } from "@/lib/persona-evidence";
import { buildReportEvidenceCatalog } from "@/lib/report-evidence";
import {
  evaluateContextRefreshDecision,
  evaluateReasoningCheckpoint,
  REASONING_POLICY_VERSION,
} from "@/lib/reasoning-runtime";
import type { SourceConnectorAuditSummary } from "@/lib/source-connectors";
import type { StudyMethod, WorkflowType } from "@/lib/research-types";
import {
  describeBuiltInSkills,
  getRunSkillBinding,
  lockRunBuiltInSkills,
  resolveBuiltInSkill,
  type SkillSummary,
} from "@/lib/skill-gateway";
import { hashJson } from "@/lib/skill-executor";
import {
  TaskTerminalFailure,
  classifyTaskError,
  recoverInterruptedTasks,
  startTaskAttempt,
  taskRetryDelaySeconds,
} from "@/lib/task-recovery";
import {
  acquireProviderRuntimeSlot,
  assignActiveStrategy,
  consumeProviderRateToken,
  getRuntimeLimits,
  recordBatchTaskMetrics,
  recordStrategyMetric,
  releaseProviderRuntimeSlot,
  renewProviderRuntimeSlot,
  type StrategyAssignment,
} from "@/lib/runtime-control";
import {
  decideResearchAgentAction,
  summarizeResearchAgentTaskResult,
  resolveResearchAgentRollout,
  validateResearchAgentAction,
} from "@/lib/research-agent-controller";
import { RESEARCH_AGENT_CONTROLLER_VERSION, type AgentAction } from "@/lib/research-agent-contract";
import { assessResearchAnswerability } from "@/lib/research-report-design";
import {
  appendGovernedDynamicTasks,
  dynamicTaskMutationRejectionReason,
} from "@/lib/research-task-mutation";
import { evaluateResearchAgentTrajectory } from "@/lib/research-agent-evaluation";
import {
  getGptResearcherRuntimeLimits,
  isGptResearcherEnabled,
  type GptResearcherReportType,
} from "@/lib/gpt-researcher-adapter";
import {
  getAllowedResearchAgentTaskTemplates,
  RESEARCH_AGENT_TASK_TEMPLATE_VERSION,
  validateResearchAgentTaskTemplate,
} from "@/lib/research-agent-templates";
import {
  detectRequestedResearchPlatforms,
  planResearchSources,
  type EvidenceNeed,
} from "@/lib/research-source-strategy";

type TaskStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting_input";

export type ResearchTaskDefinition = {
  key: string;
  title: string;
  toolName: ResearchToolName;
  template?: string | null;
  dependsOn: string[];
  input?: Record<string, unknown>;
  gptResearcherReportType?: GptResearcherReportType;
  evidenceNeeds?: EvidenceNeed[];
};

type HarnessStudy = {
  studyId: string;
  publicId: string;
  workspaceId: string;
  createdBy: string;
  userPublicId: string;
  runId: string;
  runStatus: string;
  runStartedAt: string | null;
  brief: string;
  studyType: string;
  framework: string;
  methods: StudyMethod[];
  audience: string;
  personaCount: number;
  estimatedTokens: number;
  workflowType: Exclude<WorkflowType, "realtime_agent">;
  workflowVersion: string;
  workflowTaskGraph: ResearchTaskDefinition[] | null;
  gptResearcherReportType?: GptResearcherReportType;
};

type StoredTask = {
  id: string;
  publicId: string;
  position: number;
  key: string;
  title: string;
  toolName: ResearchToolName;
  status: TaskStatus;
  dependsOn: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  waitingReason: string | null;
  timeoutSeconds: number;
  origin: "planned" | "dynamic";
  generation: number;
};

type HarnessState = Record<string, unknown>;

type ToolResult<Output> = {
  output: Output;
  artifactType: string;
  artifactTitle: string;
  eventPayload: Record<string, unknown>;
};

type ToolContext = {
  study: HarnessStudy;
  task: Pick<StoredTask, "key" | "publicId" | "attempt" | "toolName">;
  state: HarnessState;
  context: ContextSnapshot;
  signal: AbortSignal;
  strategy: StrategyAssignment;
  emitProgress?: (event: { type: string; payload?: Record<string, unknown> }) => Promise<void>;
};

type ResearchTool<Input, Output> = {
  name: ResearchToolName;
  version: number;
  displayName: string;
  description: string;
  capabilities: string[];
  providerStage?: ProviderStage | ((state: HarnessState) => ProviderStage | null);
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  execute(context: ToolContext, input: Input): Promise<ToolResult<Output>>;
};

function contextualBrief(study: HarnessStudy, context: ContextSnapshot, strategy?: StrategyAssignment) {
  const contextText = formatContextForPrompt(context);
  const instructionSuffix = typeof strategy?.config.instructionSuffix === "string"
    ? strategy.config.instructionSuffix.trim().slice(0, 2000)
    : "";
  return [
    study.brief,
    contextText ? `以下是当前工作区中与本研究相关的版本化上下文。只在相关时使用，并保留其引用标识：\n${contextText}` : "",
    instructionSuffix ? `本次实验分组的研究策略补充要求：\n${instructionSuffix}` : "",
  ].filter(Boolean).join("\n\n");
}

const sourceSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  excerpt: z.string(),
  connectorRunPublicId: z.string().optional(),
  candidatePublicId: z.string().optional(),
  snapshotPublicId: z.string().optional(),
  observationPublicId: z.string().optional(),
  contentHash: z.string().optional(),
  collectedAt: z.string().optional(),
});

const webResearchSchema = z.object({
  queries: z.array(z.string()),
  sources: z.array(sourceSchema),
  metadata: z.object({
    primaryProvider: z.enum(["tavily", "bing", "gpt-researcher"]),
    fallbackUsed: z.boolean(),
    queryPlanFallbackUsed: z.boolean().optional(),
    autonomousExpansionUsed: z.boolean().optional(),
    autonomousRecoveryQueryCount: z.number().optional(),
    rawStorageFallbackUsed: z.boolean().optional(),
    rawStorageFallbackReasons: z.array(z.string()).optional(),
    seedSourceCount: z.number(),
    searchSourceCount: z.number(),
    finalSourceCount: z.number(),
    candidateCount: z.number().optional(),
    rejectedCount: z.number().optional(),
    unavailableCount: z.number().optional(),
    connectorRunPublicId: z.string().optional(),
    policyVersion: z.string().optional(),
    socialConnectorEnabled: z.boolean().optional(),
    socialRequestedPlatform: z.string().nullable().optional(),
    socialCollectionMode: z.enum(["official_public_api", "public_web_plus_official_api", "public_web_search_only"]).optional(),
    socialSourceCount: z.number().optional(),
    socialCandidateCount: z.number().optional(),
    researchEngine: z.enum(["local", "gpt-researcher"]).optional(),
    researchEngineFallbackUsed: z.boolean().optional(),
    researchEngineFallbackReason: z.string().optional(),
    socialConnectorRunPublicId: z.string().optional(),
    qualityRejectedCount: z.number().optional(),
    qualityRejectionReasons: z.record(z.string(), z.number()).optional(),
    sourceStrategyVersion: z.string().optional(),
    evidenceNeeds: z.array(z.string()).optional(),
    preferredSourceModes: z.array(z.string()).optional(),
    fallbackSourceModes: z.array(z.string()).optional(),
    requestedPlatforms: z.array(z.string()).optional(),
  }),
  audit: z.custom<SourceConnectorAuditSummary>().optional(),
  audits: z.array(z.custom<SourceConnectorAuditSummary>()).optional(),
  responseId: z.string(),
  model: z.string(),
  usage: z.unknown(),
  answerability: z.custom<ReturnType<typeof assessResearchAnswerability>>().optional(),
  rejectedSourceCount: z.number().optional(),
  draftReport: z.string().max(200_000).optional(),
});

const personaSchema = z.object({
  name: z.string(),
  archetype: z.string(),
  age: z.number(),
  city: z.string(),
  occupation: z.string(),
  commute: z.string(),
  budget: z.string(),
  currentSituation: z.string(),
  goals: z.array(z.string()),
  painPoints: z.array(z.string()),
  decisionStyle: z.string(),
  tags: z.array(z.string()),
});

const personaPanelSchema = z.object({
  panel: z.object({ title: z.string(), description: z.string() }),
  personas: z.array(personaSchema),
  composition: z.array(z.object({
    name: z.string(),
    source: z.enum(["reused", "generated"]),
    publicId: z.string().nullable(),
  })).default([]),
  reusedCount: z.number().int().nonnegative().default(0),
  generatedCount: z.number().int().nonnegative().default(0),
  responseId: z.string(),
  model: z.string(),
  usage: z.unknown(),
});

type HarnessPersonaPanel = z.infer<typeof personaPanelSchema>;

const personaSearchSchema = z.object({
  query: z.string(),
  matchCount: z.number().int().nonnegative(),
  matches: z.array(z.object({
    publicId: z.string(),
    name: z.string(),
    archetype: z.string(),
    source: z.enum(["generated", "manual"]),
    profile: personaSchema,
  })),
});

const interviewSchema = z.object({
  personaName: z.string(),
  batch: z.number().int(),
  objective: z.string(),
  summary: z.string(),
  quotes: z.array(z.string()),
  insights: z.array(z.string()),
});

const validationSchema = z.object({
  calls: z.array(z.object({
    personaName: z.string(),
    archetype: z.string(),
    objective: z.string(),
    response: z.string(),
    quotes: z.array(z.string()),
    signals: z.array(z.string()),
  })).default([]),
  directions: z.array(z.object({
    title: z.string(),
    appeal: z.string(),
    resistance: z.string(),
    verdict: z.enum(["strong", "mixed", "weak"]),
  })),
  summary: z.string(),
});

const discussionSchema: z.ZodType<ProviderResearchDiscussion> = z.object({
  title: z.string(),
  topic: z.string(),
  participantCount: z.number().int().nonnegative(),
  participants: z.array(z.string()),
  messages: z.array(z.object({
    id: z.string(),
    speaker: z.string(),
    archetype: z.string(),
    round: z.number().int().positive(),
    content: z.string(),
  })),
  findings: z.array(z.string()),
  consensus: z.array(z.string()),
  disagreements: z.array(z.string()),
  positionShifts: z.array(z.string()),
  unexpectedThemes: z.array(z.string()),
  instruction: z.string(),
  timelineToken: z.string(),
  disclaimer: z.string(),
});

const reportSchema = z.object({
  report: z.custom<ResearchReport>(),
  citations: z.array(z.object({ title: z.string(), url: z.string().url() })),
  responseId: z.string(),
  model: z.string(),
  provider: z.string(),
  promptVersion: z.string(),
  usage: z.unknown(),
});

const reportQualityReviewSchema = z.object({
  verdict: z.enum(["approved", "revise"]),
  score: z.number().int().min(0).max(100),
  summary: z.string(),
  issues: z.array(z.object({
    severity: z.enum(["high", "medium", "low"]),
    category: z.enum([
      "unsupported_claim",
      "evidence_mismatch",
      "missing_counterevidence",
      "synthetic_overstatement",
      "actionability",
      "structure",
      "intent_mismatch",
      "source_quality",
      "answerability",
      "reader_value",
    ]),
    description: z.string(),
    recommendation: z.string(),
  })),
  responseId: z.string(),
  model: z.string(),
  provider: z.string(),
  promptVersion: z.string(),
  usage: z.unknown(),
});

const finalReportSchema = reportSchema.extend({
  qualityReview: reportQualityReviewSchema,
  revisionApplied: z.boolean(),
});

function readState<Output>(state: HarnessState, key: string, schema: z.ZodType<Output>): Output {
  const parsed = schema.safeParse(state[key]);
  if (!parsed.success) throw new Error(`HARNESS_STATE_MISSING:${key}`);
  return parsed.data;
}

function mergedResearchState(state: HarnessState): ProviderResearchSources {
  const packets = Object.values(state).flatMap((value) => {
    const parsed = webResearchSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  if (!packets.length) throw new Error("HARNESS_STATE_MISSING:research");
  const sources = [...new Map(packets.flatMap((packet) => packet.sources).map((source) => [source.url, source])).values()];
  const queries = [...new Set(packets.flatMap((packet) => packet.queries))];
  const primary = packets[0];
  return {
    ...primary,
    queries,
    sources,
    metadata: {
      ...primary.metadata,
      seedSourceCount: packets.reduce((total, packet) => total + packet.metadata.seedSourceCount, 0),
      searchSourceCount: packets.reduce((total, packet) => total + packet.metadata.searchSourceCount, 0),
      finalSourceCount: sources.length,
      fallbackUsed: packets.some((packet) => packet.metadata.fallbackUsed),
      queryPlanFallbackUsed: packets.some((packet) => packet.metadata.queryPlanFallbackUsed === true),
      autonomousExpansionUsed: packets.some((packet) => packet.metadata.autonomousExpansionUsed === true),
      autonomousRecoveryQueryCount: packets.reduce((total, packet) => total + (packet.metadata.autonomousRecoveryQueryCount ?? 0), 0),
      rawStorageFallbackUsed: packets.some((packet) => packet.metadata.rawStorageFallbackUsed === true),
      rawStorageFallbackReasons: [...new Set(packets.flatMap((packet) => packet.metadata.rawStorageFallbackReasons ?? []))],
      qualityRejectedCount: packets.reduce((total, packet) => total + (packet.metadata.qualityRejectedCount ?? 0), 0),
      qualityRejectionReasons: packets.reduce<Record<string, number>>((counts, packet) => {
        for (const [reason, count] of Object.entries(packet.metadata.qualityRejectionReasons ?? {})) {
          counts[reason] = (counts[reason] ?? 0) + count;
        }
        return counts;
      }, {}),
    },
    answerability: packets.find((packet) => packet.answerability)?.answerability,
    rejectedSourceCount: packets.reduce((total, packet) => total + (packet.rejectedSourceCount ?? 0), 0),
  };
}

function collectReportEvidence(state: HarnessState) {
  const research = mergedResearchState(state);
  const personaResult = personaPanelSchema.safeParse(state.personas);
  const batchOne = z.array(interviewSchema).safeParse(state.interviews_one);
  const batchTwo = z.array(interviewSchema).safeParse(state.interviews_two);
  const validation = validationSchema.safeParse(state.validation);
  const discussion = discussionSchema.safeParse(state.discussion);
  const panelResearch = personaResult.success && validation.success
    ? {
        panel: personaResult.data.panel,
        personas: personaResult.data.personas,
        interviews: [
          ...(batchOne.success ? batchOne.data : []),
          ...(batchTwo.success ? batchTwo.data : []),
        ],
        validation: validation.data,
      }
    : undefined;
  return {
    research,
    panelResearch,
    discussion: discussion.success ? discussion.data : undefined,
    evidenceCatalog: buildReportEvidenceCatalog({
      sources: research.sources,
      panelResearch,
      discussion: discussion.success ? discussion.data : undefined,
    }),
  };
}

const designStudyTool: ResearchTool<Record<string, never>, Record<string, unknown>> = {
  name: "designStudy",
  version: 1,
  displayName: "研究设计",
  description: "将确认后的研究计划转换为可执行任务。",
  capabilities: ["research.plan"],
  inputSchema: z.object({}),
  outputSchema: z.record(z.string(), z.unknown()),
  async execute({ study }) {
    const sourceStrategy = planResearchSources({ brief: study.brief, methods: study.methods });
    const output = {
      framework: study.framework,
      methods: study.methods,
      audience: study.audience,
      executionMode: "durable_plan_and_execute",
      sourceStrategy,
    };
    return {
      output,
      artifactType: "research_plan",
      artifactTitle: "研究执行计划",
      eventPayload: { framework: study.framework, methods: study.methods, sourceStrategy },
    };
  },
};

const researchInputSchema = z.object({
  platform: z.string().optional(),
  collectionMode: z.enum(["official_public_api", "public_web_search_only"]).optional(),
  focus: z.string().optional(),
  gptResearcherReportType: z.enum(["research_report", "deep", "detailed_report", "subtopic_report"]).optional(),
  resumeInput: z.object({
    focus: z.string().max(600).optional(),
    sourceUrls: z.array(z.string().url()).max(8).optional(),
    selectedOption: z.string().max(160).optional(),
  }).optional(),
  evidenceNeeds: z.array(z.enum([
    "market_facts",
    "first_person_voice",
    "behavior_metrics",
    "official_platform_data",
    "competitor_comparison",
    "primary_research",
  ])).max(8).optional(),
  sourceStrategyVersion: z.string().max(80).optional(),
});

const webResearchTool: ResearchTool<z.infer<typeof researchInputSchema>, ProviderResearchSources> = {
  name: "deepResearch",
  version: 1,
  displayName: "公开资料研究",
  description: "检索并整理公开网页及已启用的官方社交 API 证据。",
  capabilities: ["web.search", "research.sources"],
  providerStage: "research",
  inputSchema: researchInputSchema,
  outputSchema: webResearchSchema,
  async execute({ study, task, context, signal, strategy, emitProgress }, input) {
    const output = await researchPublicWeb({
      brief: [contextualBrief(study, context, strategy), input.platform ? `重点平台：${input.platform}` : "", input.focus ? `研究焦点：${input.focus}` : "", input.resumeInput?.focus ? `用户补充研究焦点：${input.resumeInput.focus}` : "", input.resumeInput?.selectedOption ? `用户选择：${input.resumeInput.selectedOption}` : ""].filter(Boolean).join("\n"),
      framework: study.framework,
      userPublicId: study.userPublicId,
      studyPublicId: study.publicId,
      auditScope: {
        workspaceId: study.workspaceId,
        studyId: study.studyId,
        runId: study.runId,
        taskKey: task.key,
        attempt: task.attempt,
      },
      signal,
      additionalSeedUrls: input.resumeInput?.sourceUrls,
      reportType: input.gptResearcherReportType ?? study.gptResearcherReportType,
      evidenceNeeds: input.evidenceNeeds,
      sourceStrategyVersion: input.sourceStrategyVersion,
      socialPlatform: input.platform,
      engine: task.toolName === "scoutSocialTrends" ? "local" : "configured",
      onProgress: async (event) => emitProgress?.(event),
    });
    return {
      output,
      artifactType: "public_sources",
      artifactTitle: "公开来源证据包",
      eventPayload: {
        queryCount: output.queries.length,
        queries: output.queries,
        sourceCount: output.sources.length,
        sources: output.sources.map(({ title, url }) => ({ title, url })),
        provider: output.metadata.primaryProvider,
        answerability: output.answerability,
        rejectedSourceCount: output.rejectedSourceCount ?? output.metadata.qualityRejectedCount ?? 0,
        autonomousExpansionUsed: output.metadata.autonomousExpansionUsed ?? false,
        autonomousRecoveryQueryCount: output.metadata.autonomousRecoveryQueryCount ?? 0,
        queryPlanFallbackUsed: output.metadata.queryPlanFallbackUsed ?? false,
        rawStorageFallbackUsed: output.metadata.rawStorageFallbackUsed ?? false,
        rawStorageFallbackReasons: output.metadata.rawStorageFallbackReasons ?? [],
        platform: input.platform ?? "public_web",
        collectionMode: input.collectionMode ?? "public_web_search_only",
        focus: input.resumeInput?.focus ?? input.focus ?? "行业与用户背景",
        socialConnectorEnabled: output.metadata.socialConnectorEnabled ?? false,
        socialSourceCount: output.metadata.socialSourceCount ?? 0,
        socialCandidateCount: output.metadata.socialCandidateCount ?? 0,
        researchEngine: output.metadata.researchEngine ?? "local",
        researchEngineFallbackUsed: output.metadata.researchEngineFallbackUsed ?? false,
        researchEngineFallbackReason: output.metadata.researchEngineFallbackReason,
        sourceStrategyVersion: output.metadata.sourceStrategyVersion,
        evidenceNeeds: output.metadata.evidenceNeeds,
        preferredSourceModes: output.metadata.preferredSourceModes,
        fallbackSourceModes: output.metadata.fallbackSourceModes,
        requestedPlatforms: output.metadata.requestedPlatforms,
      },
    };
  },
};

const scoutResearchTool: ResearchTool<z.infer<typeof researchInputSchema>, ProviderResearchSources> = {
  ...webResearchTool,
  name: "scoutSocialTrends",
  displayName: "社交趋势扫描",
  description: "按平台连接器能力扫描趋势、场景和用户表达；未配置官方连接器时仅检索公开网页，不执行站内爬虫。",
  capabilities: ["web.search", "social.scout", "research.sources"],
};

const searchPersonasTool: ResearchTool<Record<string, never>, z.infer<typeof personaSearchSchema>> = {
  name: "searchPersonas",
  version: 1,
  displayName: "Persona 检索",
  description: "在工作区 Persona 资产中检索可复用样本。",
  capabilities: ["persona.search"],
  inputSchema: z.object({}),
  outputSchema: personaSearchSchema,
  async execute({ study }) {
    const database = await getDatabase();
    const result = await database.query<{
      public_id: string;
      name: string;
      archetype: string;
      source: "generated" | "manual";
      profile: unknown;
    }>(
      `select public_id, name, archetype, source, profile
       from study_personas
       where workspace_id = $1
         and (visibility = 'workspace' or created_by = $2)
         and (study_id is null or study_id <> $3)
         and retention_status = 'retained'
         and (valid_until is null or valid_until > now())
       order by updated_at desc, id desc
       limit 80`,
      [study.workspaceId, study.createdBy, study.studyId],
    );
    const keywordChunks = `${study.audience} ${study.brief}`.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) ?? [];
    const keywords = [...new Set(keywordChunks.flatMap((chunk) => {
      if (!/[\p{Script=Han}]/u.test(chunk) || chunk.length <= 4) return [chunk];
      const fragments: string[] = [chunk];
      for (let index = 0; index < chunk.length - 1; index += 1) fragments.push(chunk.slice(index, index + 2));
      return fragments;
    }))].filter((keyword) => !["研究", "用户", "目标", "现有", "产品", "进行", "需要"].includes(keyword));
    const matches = result.rows.flatMap((row) => {
      const profile = personaSchema.safeParse(parseJson(row.profile));
      return profile.success ? [{
        publicId: row.public_id,
        name: row.name,
        archetype: row.archetype,
        source: row.source,
        profile: profile.data,
        score: keywords.reduce((score, keyword) => {
          const searchable = `${row.name} ${row.archetype} ${JSON.stringify(profile.data)}`.toLowerCase();
          return score + (searchable.includes(keyword) ? Math.max(1, keyword.length - 1) : 0);
        }, 0),
      }] : [];
    }).filter((match) => match.score > 0).sort((left, right) => right.score - left.score).slice(0, 10).map((match) => ({
      publicId: match.publicId,
      name: match.name,
      archetype: match.archetype,
      source: match.source,
      profile: match.profile,
    }));
    const output = {
      query: `${study.audience} · ${study.brief}`,
      matchCount: matches.length,
      matches,
    };
    return {
      output,
      artifactType: "persona_search",
      artifactTitle: "工作区 Persona 检索结果",
      eventPayload: {
        count: matches.length,
        names: matches.map((persona) => persona.name),
        query: study.audience,
      },
    };
  },
};

const buildPersonaTool: ResearchTool<Record<string, never>, HarnessPersonaPanel> = {
  name: "buildPersona",
  version: 1,
  displayName: "Persona 构建",
  description: "结合研究证据和已有 Persona 构建合成样本。",
  capabilities: ["persona.generate", "context.consume"],
  providerStage: "research",
  inputSchema: z.object({}),
  outputSchema: personaPanelSchema,
  async execute({ study, state, context, signal, strategy }) {
    const research = mergedResearchState(state);
    const personaSearch = personaSearchSchema.safeParse(state.persona_search);
    const generated = await buildProviderPersonaPanel({
      brief: contextualBrief(study, context, strategy),
      framework: study.framework,
      methods: study.methods,
      audience: study.audience,
      userPublicId: study.userPublicId,
      studyPublicId: study.publicId,
      sources: research.sources,
      existingPersonas: personaSearch.success ? personaSearch.data.matches.map((match) => ({
        name: match.name,
        archetype: match.archetype,
        city: match.profile.city,
        occupation: match.profile.occupation,
        goals: match.profile.goals,
        painPoints: match.profile.painPoints,
      })) : [],
      signal,
    });
    const total = Math.max(6, Math.min(12, study.personaCount));
    const reusable = personaSearch.success
      ? personaSearch.data.matches.slice(0, Math.min(4, Math.floor(total / 2)))
      : [];
    const reusedProfiles = reusable.map((match) => match.profile);
    const reusedNames = new Set(reusedProfiles.map((persona) => persona.name));
    const generatedProfiles = generated.personas.filter((persona) => !reusedNames.has(persona.name)).slice(0, total - reusedProfiles.length);
    const personas = [...reusedProfiles, ...generatedProfiles];
    const output: HarnessPersonaPanel = {
      ...generated,
      panel: {
        ...generated.panel,
        description: `${generated.panel.description} 本 Panel 由 ${reusedProfiles.length} 个工作区复用 Persona 与 ${generatedProfiles.length} 个本次新建 Persona 组合。`,
      },
      personas,
      composition: [
        ...reusable.map((match) => ({ name: match.name, source: "reused" as const, publicId: match.publicId })),
        ...generatedProfiles.map((persona) => ({ name: persona.name, source: "generated" as const, publicId: null })),
      ],
      reusedCount: reusedProfiles.length,
      generatedCount: generatedProfiles.length,
    };
    return {
      output,
      artifactType: "persona_set",
      artifactTitle: "AI 合成 Persona",
      eventPayload: {
        count: output.personas.length,
        names: output.personas.map((persona) => persona.name),
        reusedCount: output.reusedCount,
        generatedCount: output.generatedCount,
      },
    };
  },
};

const createPanelTool: ResearchTool<Record<string, never>, HarnessPersonaPanel["panel"]> = {
  name: "createPanel",
  version: 1,
  displayName: "Panel 创建",
  description: "将 Persona 集合物化为研究 Panel。",
  capabilities: ["panel.create"],
  inputSchema: z.object({}),
  outputSchema: personaPanelSchema.shape.panel,
  async execute({ state }) {
    const personaPanel = readState(state, "personas", personaPanelSchema);
    return {
      output: personaPanel.panel,
      artifactType: "panel",
      artifactTitle: personaPanel.panel.title,
      eventPayload: { title: personaPanel.panel.title, count: personaPanel.personas.length },
    };
  },
};

function interviewTool(batch: 1 | 2): ResearchTool<{ batch: 1 | 2; objective?: string }, ProviderResearchInterviews> {
  return {
    name: batch === 1 ? "interviewChatBatchOne" : "interviewChatBatchTwo",
    version: 1,
    displayName: batch === 1 ? "合成访谈：决策路径" : "合成访谈：体验与阻力",
    description: "对合成 Persona 执行结构化批量访谈。",
    capabilities: ["interview.synthetic", "context.consume"],
    providerStage: "research",
    inputSchema: z.object({ batch: z.union([z.literal(1), z.literal(2)]), objective: z.string().optional() }),
    outputSchema: z.array(interviewSchema),
    async execute({ study, state, context, signal, strategy }) {
      const personaPanel = readState(state, "personas", personaPanelSchema);
      const output = await generateProviderResearchInterviews({
        brief: contextualBrief(study, context, strategy),
        audience: study.audience,
        userPublicId: study.userPublicId,
        studyPublicId: study.publicId,
        personas: personaPanel.personas,
        batch,
        signal,
      });
      return {
        output,
        artifactType: `synthetic_interviews_batch_${batch}`,
        artifactTitle: `AI 模拟访谈第 ${batch} 批`,
        eventPayload: {
          participantCount: output.length,
          participants: output.map((interview) => interview.personaName),
        },
      };
    },
  };
}

const validateDirectionsTool: ResearchTool<Record<string, never>, ProviderDeepResearchValidation> = {
  name: "audienceCall",
  version: 1,
  displayName: "方向验证",
  description: "用合成受众对候选方向进行压力测试。",
  capabilities: ["audience.validate", "context.consume"],
  providerStage: "reasoning",
  inputSchema: z.object({}),
  outputSchema: validationSchema,
  async execute({ study, state, context, signal, strategy }) {
    const personaPanel = readState(state, "personas", personaPanelSchema);
    const batchOne = z.array(interviewSchema).safeParse(state.interviews_one);
    const batchTwo = z.array(interviewSchema).safeParse(state.interviews_two);
    const output = await runProviderAudienceCall({
      brief: contextualBrief(study, context, strategy),
      audience: study.audience,
      userPublicId: study.userPublicId,
      studyPublicId: study.publicId,
      personas: personaPanel.personas,
      interviews: [...(batchOne.success ? batchOne.data : []), ...(batchTwo.success ? batchTwo.data : [])],
      signal,
    });
    return {
      output,
      artifactType: "direction_validation",
      artifactTitle: "候选方向压力测试",
      eventPayload: {
        directionCount: output.directions.length,
        directions: output.directions.map(({ title, verdict }) => ({ title, verdict })),
        participants: output.calls.map((call) => call.personaName),
      },
    };
  },
};

const discussionInputSchema = z.object({ instruction: z.string(), timelineToken: z.string() });

const discussionChatTool: ResearchTool<z.infer<typeof discussionInputSchema>, ProviderResearchDiscussion> = {
  name: "discussionChat",
  version: 1,
  displayName: "合成焦点讨论",
  description: "主持多 Persona 焦点讨论并提取共识与分歧。",
  capabilities: ["discussion.synthetic", "context.consume"],
  providerStage: "reasoning",
  inputSchema: discussionInputSchema,
  outputSchema: discussionSchema,
  async execute({ study, state, context, signal, strategy }, input) {
    const personaPanel = readState(state, "personas", personaPanelSchema);
    const validation = validationSchema.safeParse(state.validation);
    const batchOne = z.array(interviewSchema).safeParse(state.interviews_one);
    const batchTwo = z.array(interviewSchema).safeParse(state.interviews_two);
    const output = await runProviderDiscussionChat({
      brief: contextualBrief(study, context, strategy),
      audience: study.audience,
      userPublicId: study.userPublicId,
      studyPublicId: study.publicId,
      personas: personaPanel.personas,
      interviews: [...(batchOne.success ? batchOne.data : []), ...(batchTwo.success ? batchTwo.data : [])],
      validation: validation.success ? validation.data : undefined,
      instruction: input.instruction,
      timelineToken: input.timelineToken,
      signal,
    });
    return {
      output,
      artifactType: "discussion_transcript",
      artifactTitle: output.title,
      eventPayload: {
        participantCount: output.participantCount,
        participants: output.participants,
        messageCount: output.messages.length,
        findingCount: output.findings.length,
      },
    };
  },
};

const generateReportTool: ResearchTool<Record<string, never>, z.infer<typeof reportSchema>> = {
  name: "generateReport",
  version: 1,
  displayName: "研究报告生成",
  description: "综合证据、访谈和讨论生成带来源的研究报告。",
  capabilities: ["report.generate", "context.consume"],
  providerStage: "report",
  inputSchema: z.object({}),
  outputSchema: reportSchema,
  async execute({ study, state, context, signal, strategy }) {
    const { research, panelResearch, discussion } = collectReportEvidence(state);
    const answerability = assessResearchAnswerability({
      brief: study.brief,
      sources: research.sources,
      hasSyntheticResearch: Boolean(panelResearch || discussion),
    });
    const generated = await synthesizeProviderResearchReport({
      brief: contextualBrief(study, context, strategy),
      framework: study.framework,
      methods: study.methods,
      audience: study.audience,
      userPublicId: study.userPublicId,
      studyPublicId: study.publicId,
      queries: research.queries,
      sources: research.sources,
      draftReport: research.draftReport,
      panelResearch,
      discussion,
      answerability,
      signal,
    });
    const output = {
      ...generated,
      citations: research.sources.map(({ title, url }) => ({ title, url })),
    };
    return {
      output,
      artifactType: "research_report_draft",
      artifactTitle: generated.report.title,
      eventPayload: {
        citationCount: output.citations.length,
        findingCount: output.report.findings.length,
        title: output.report.title,
        provider: output.provider,
        model: output.model,
      },
    };
  },
};

const judgeReportTool: ResearchTool<Record<string, never>, z.infer<typeof reportQualityReviewSchema>> = {
  name: "judgeReport",
  version: 1,
  displayName: "报告质量评审",
  description: "独立核查报告的证据一致性、模拟证据表述与可执行性。",
  capabilities: ["report.judge", "context.consume"],
  providerStage: "judge",
  inputSchema: z.object({}),
  outputSchema: reportQualityReviewSchema,
  async execute({ study, state, signal }) {
    const draft = readState(state, "report", reportSchema);
    const { evidenceCatalog, research } = collectReportEvidence(state);
    const answerability = assessResearchAnswerability({ brief: study.brief, sources: research.sources });
    const output = await judgeProviderResearchReport({
      report: draft.report,
      evidenceCatalog,
      answerability,
      userPublicId: study.userPublicId,
      studyPublicId: study.publicId,
      signal,
    });
    return {
      output,
      artifactType: "report_quality_review",
      artifactTitle: `报告质量评审：${output.score} 分`,
      eventPayload: {
        verdict: output.verdict,
        score: output.score,
        issueCount: output.issues.length,
        provider: output.provider,
        model: output.model,
      },
    };
  },
};

export function finalizeApprovedReportPacket(
  draft: z.infer<typeof reportSchema>,
  review: z.infer<typeof reportQualityReviewSchema>,
): z.infer<typeof finalReportSchema> {
  if (review.verdict !== "approved") throw new Error("REPORT_REQUIRES_REVISION");
  return finalReportSchema.parse({
    ...draft,
    usage: null,
    qualityReview: review,
    revisionApplied: false,
  });
}

export function finalizeRevisedReportPacket(
  draft: z.infer<typeof reportSchema>,
  review: z.infer<typeof reportQualityReviewSchema>,
  revised: Omit<z.infer<typeof reportSchema>, "citations">,
): z.infer<typeof finalReportSchema> {
  if (review.verdict !== "revise") throw new Error("REPORT_REVISION_NOT_REQUIRED");
  return finalReportSchema.parse({
    ...revised,
    citations: draft.citations,
    qualityReview: review,
    revisionApplied: true,
  });
}

const finalizeReportTool: ResearchTool<Record<string, never>, z.infer<typeof finalReportSchema>> = {
  name: "finalizeReport",
  version: 1,
  displayName: "报告定稿",
  description: "评审通过时直接定稿，未通过时按评审问题定向修订。",
  capabilities: ["report.finalize", "context.consume"],
  providerStage: (state) => {
    const review = reportQualityReviewSchema.safeParse(state.report_review);
    return review.success && review.data.verdict === "approved" ? null : "report";
  },
  inputSchema: z.object({}),
  outputSchema: finalReportSchema,
  async execute({ study, state, signal }) {
    const draft = readState(state, "report", reportSchema);
    const review = readState(state, "report_review", reportQualityReviewSchema);
    if (review.verdict === "approved") {
      const output = finalizeApprovedReportPacket(draft, review);
      return {
        output,
        artifactType: "research_report",
        artifactTitle: draft.report.title,
        eventPayload: {
          title: draft.report.title,
          verdict: review.verdict,
          score: review.score,
          revisionApplied: false,
          provider: draft.provider,
          model: draft.model,
        },
      };
    }
    const { evidenceCatalog } = collectReportEvidence(state);
    const revised = await reviseProviderResearchReport({
      report: draft.report,
      review,
      evidenceCatalog,
      userPublicId: study.userPublicId,
      studyPublicId: study.publicId,
      signal,
    });
    const output = finalizeRevisedReportPacket(draft, review, revised);
    return {
      output,
      artifactType: "research_report",
      artifactTitle: revised.report.title,
      eventPayload: {
        title: revised.report.title,
        verdict: review.verdict,
        score: review.score,
        revisionApplied: true,
        provider: revised.provider,
        model: revised.model,
      },
    };
  },
};

const researchTools = {
  designStudy: designStudyTool,
  deepResearch: webResearchTool,
  scoutSocialTrends: scoutResearchTool,
  searchPersonas: searchPersonasTool,
  buildPersona: buildPersonaTool,
  createPanel: createPanelTool,
  interviewChatBatchOne: interviewTool(1),
  interviewChatBatchTwo: interviewTool(2),
  audienceCall: validateDirectionsTool,
  discussionChat: discussionChatTool,
  generateReport: generateReportTool,
  judgeReport: judgeReportTool,
  finalizeReport: finalizeReportTool,
};

export type ResearchToolName = keyof typeof researchTools;
const agentDynamicToolNames: readonly ResearchToolName[] = ["deepResearch", "scoutSocialTrends"];

function socialTaskTitle(platform: string, directConnectorEnabled: boolean) {
  if (platform === "Bluesky" && directConnectorEnabled) return "扫描 Bluesky 公开 API 趋势与用户表达";
  if (platform === "公开社交信号") return "检索公开网页中的社交趋势与用户表达";
  return `检索 ${platform} 相关公开网页信号（非站内爬虫）`;
}

export function listResearchSkills(): SkillSummary[] {
  return describeBuiltInSkills(Object.values(researchTools).map((tool) => ({
    slug: tool.name,
    version: tool.version,
    name: tool.displayName,
    description: tool.description,
    capabilities: tool.capabilities,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  })));
}

export function createResearchTaskPlan(input: {
  studyType: string;
  methods: StudyMethod[];
  brief?: string;
  personaCount?: number;
  gptResearcherReportType?: GptResearcherReportType;
}): ResearchTaskDefinition[] {
  const sourceStrategy = planResearchSources({ brief: input.brief, methods: input.methods });
  const tasks: ResearchTaskDefinition[] = [{
    key: "design",
    title: "设计研究框架与执行步骤",
    toolName: "designStudy",
    dependsOn: [],
  }];
  const sourceTool = input.methods.includes("Scout Agent") ? "scoutSocialTrends" : "deepResearch";
  const platformCandidates = detectRequestedResearchPlatforms(input.brief);
  const directConnectorEnabled = getBlueskyPublicConnectorStatus().enabled;
  const platforms = sourceTool === "scoutSocialTrends"
    ? (platformCandidates.length ? platformCandidates : ["公开社交信号"]).slice(0, 3)
    : [];
  const researchTasks: ResearchTaskDefinition[] = platforms.length
    ? platforms.map((platform, index) => ({
        key: `research_${index + 1}`,
        title: socialTaskTitle(platform, directConnectorEnabled),
        toolName: sourceTool,
        dependsOn: ["design"],
        input: { platform, collectionMode: platform === "Bluesky" && directConnectorEnabled ? "official_public_api" : "public_web_search_only", focus: index === 0 ? "痛点、场景与自然语言表达" : "比较、阻力与决策触发", gptResearcherReportType: input.gptResearcherReportType ?? "research_report", evidenceNeeds: sourceStrategy.evidenceNeeds, sourceStrategyVersion: sourceStrategy.version },
        gptResearcherReportType: input.gptResearcherReportType ?? "research_report",
        evidenceNeeds: sourceStrategy.evidenceNeeds,
      }))
    : [{
        key: "research",
        title: "研究公开资料、行业背景与用户场景",
        toolName: sourceTool,
        dependsOn: ["design"],
        input: { focus: "行业事实、竞品、用户场景与决策约束", gptResearcherReportType: input.gptResearcherReportType ?? "research_report", evidenceNeeds: sourceStrategy.evidenceNeeds, sourceStrategyVersion: sourceStrategy.version },
        gptResearcherReportType: input.gptResearcherReportType ?? "research_report",
        evidenceNeeds: sourceStrategy.evidenceNeeds,
      }];
  tasks.push(...researchTasks);
  const researchDependencies = researchTasks.map((task) => task.key);

  const needsPersonas = input.studyType === "panel_only"
    || input.methods.includes("Interview Chat")
    || input.methods.includes("Discussion Chat");
  if (needsPersonas) {
    tasks.push({
      key: "persona_search",
      title: "检索工作区 Persona 资产",
      toolName: "searchPersonas",
      dependsOn: researchDependencies,
    });
    tasks.push({
      key: "personas",
      title: "构建差异化 AI 合成 Persona",
      toolName: "buildPersona",
      dependsOn: ["persona_search"],
    });
    tasks.push({
      key: "panel",
      title: "创建研究 Panel",
      toolName: "createPanel",
      dependsOn: ["personas"],
    });
  }

  if (input.methods.includes("Interview Chat")) {
    tasks.push({
      key: "interviews_one",
      title: "模拟访谈：决策路径",
      toolName: "interviewChatBatchOne",
      dependsOn: ["panel"],
      input: { batch: 1, objective: "换购触发、信息搜索、比较筛选和最终决策路径" },
    });
    tasks.push({
      key: "interviews_two",
      title: "模拟访谈：体验与阻力",
      toolName: "interviewChatBatchTwo",
      dependsOn: ["panel"],
      input: { batch: 2, objective: "真实使用体验、关键焦虑、场景变化和功能机会" },
    });
  }

  if (needsPersonas && input.studyType !== "panel_only") {
    const interviewDependencies = tasks
      .filter((task) => task.key.startsWith("interviews_"))
      .map((task) => task.key);
    tasks.push({
      key: "validation",
      title: "快速验证候选方向",
      toolName: "audienceCall",
      dependsOn: interviewDependencies.length ? interviewDependencies : ["panel"],
    });
  }

  if (input.methods.includes("Discussion Chat")) {
    tasks.push({
      key: "discussion",
      title: "开展 AI 合成焦点讨论",
      toolName: "discussionChat",
      dependsOn: tasks.some((task) => task.key === "validation") ? ["validation"] : ["panel"],
      input: {
        instruction: "主持三轮焦点讨论：先陈述个人判断，再围绕关键分歧互相追问，最后说明听取他人后立场是否变化；归纳共识、分歧、意外主题和决策条件。",
        timelineToken: randomUUID(),
      },
    });
  }

  if (input.studyType !== "panel_only") {
    tasks.push({
      key: "report",
      title: "生成研究报告初稿",
      toolName: "generateReport",
      dependsOn: [tasks.at(-1)?.key ?? researchDependencies.at(-1) ?? "design"],
    });
    tasks.push({
      key: "report_review",
      title: "独立评审报告质量",
      toolName: "judgeReport",
      dependsOn: ["report"],
    });
    tasks.push({
      key: "final_report",
      title: "定稿研究报告",
      toolName: "finalizeReport",
      dependsOn: ["report_review"],
    });
  }

  return tasks;
}

export function createMarketInsightTaskPlan(input: {
  methods: StudyMethod[];
  brief?: string;
  gptResearcherReportType?: GptResearcherReportType;
}): ResearchTaskDefinition[] {
  const sourceStrategy = planResearchSources({ brief: input.brief, methods: input.methods });
  const sourceTool: ResearchToolName = input.methods.includes("Scout Agent")
    ? "scoutSocialTrends"
    : "deepResearch";
  const sourceLabel = sourceTool === "scoutSocialTrends" ? "公开趋势与社交信号" : "公开市场与行业资料";

  return [
    {
      key: "design",
      title: "定义市场边界、证据标准与分析维度",
      toolName: "designStudy",
      dependsOn: [],
      input: { productLine: "market_insight", brief: input.brief ?? "" },
    },
    {
      key: "market_landscape",
      title: "建立市场格局与品类变化基线",
      toolName: "deepResearch",
      dependsOn: ["design"],
      input: { focus: "市场规模信号、品类结构、增长驱动、政策与渠道变化", gptResearcherReportType: input.gptResearcherReportType ?? "research_report", evidenceNeeds: sourceStrategy.evidenceNeeds, sourceStrategyVersion: sourceStrategy.version },
      gptResearcherReportType: input.gptResearcherReportType ?? "research_report",
      evidenceNeeds: sourceStrategy.evidenceNeeds,
    },
    {
      key: "competitive_signals",
      title: "梳理竞争信号与替代方案",
      toolName: "deepResearch",
      dependsOn: ["design"],
      input: { focus: "主要竞品、替代方案、定位差异、定价动作与能力缺口", gptResearcherReportType: input.gptResearcherReportType ?? "research_report", evidenceNeeds: sourceStrategy.evidenceNeeds, sourceStrategyVersion: sourceStrategy.version },
      gptResearcherReportType: input.gptResearcherReportType ?? "research_report",
      evidenceNeeds: sourceStrategy.evidenceNeeds,
    },
    {
      key: "opportunity_signals",
      title: `扫描${sourceLabel}中的机会信号`,
      toolName: sourceTool,
      dependsOn: ["design"],
      input: { focus: "新兴需求、未满足场景、用户自然语言、弱信号与反向证据", gptResearcherReportType: input.gptResearcherReportType ?? "research_report", evidenceNeeds: sourceStrategy.evidenceNeeds, sourceStrategyVersion: sourceStrategy.version },
      gptResearcherReportType: input.gptResearcherReportType ?? "research_report",
      evidenceNeeds: sourceStrategy.evidenceNeeds,
    },
    {
      key: "report",
      title: "生成市场洞察与机会地图初稿",
      toolName: "generateReport",
      dependsOn: ["market_landscape", "competitive_signals", "opportunity_signals"],
      input: { outputType: "market_insight", evidenceRequired: true },
    },
    {
      key: "report_review",
      title: "独立评审市场洞察报告",
      toolName: "judgeReport",
      dependsOn: ["report"],
    },
    {
      key: "final_report",
      title: "定稿市场洞察与机会地图",
      toolName: "finalizeReport",
      dependsOn: ["report_review"],
    },
  ];
}

async function appendEvent(
  database: Awaited<ReturnType<typeof getDatabase>>,
  studyId: string,
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
) {
  await database.query(
    `insert into study_events (study_id, run_id, event_type, payload)
     values ($1, $2, $3, $4::jsonb)`,
    [studyId, runId, type, JSON.stringify(payload)],
  );
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

async function loadHarnessStudy(runId: string): Promise<HarnessStudy | null> {
  const database = await getDatabase();
  const result = await database.query<{
    study_id: string;
    public_id: string;
    workspace_id: string;
    created_by: string;
    user_public_id: string;
    run_id: string;
    run_status: string;
    run_started_at: string | null;
    brief: string;
    study_type: string;
    framework: string;
    methods: StudyMethod[] | string;
    persona_filters: { audience?: string } | string;
    persona_count: number;
    gpt_researcher_report_type: GptResearcherReportType;
    estimated_tokens: string;
    workflow_type: Exclude<WorkflowType, "realtime_agent">;
    workflow_version: string;
    workflow_task_graph: ResearchTaskDefinition[] | string | null;
  }>(
    `select study.id::text as study_id, study.public_id,
            study.workspace_id::text as workspace_id, study.created_by::text as created_by,
            app_user.public_id as user_public_id, run.id::text as run_id,
            run.status as run_status, run.started_at::text as run_started_at,
            study.brief, study.study_type, study.estimated_tokens::text as estimated_tokens,
            plan.framework, plan.methods, plan.persona_filters, plan.persona_count,
            plan.gpt_researcher_report_type,
            run.workflow_type, run.workflow_version, workflow.task_graph as workflow_task_graph
     from study_runs run
     join studies study on study.id = run.study_id
     join study_plan_versions plan on plan.id = run.plan_version_id
     left join workflow_definitions workflow on workflow.id = run.workflow_definition_id
     join users app_user on app_user.id = study.created_by
     where run.id = $1
     limit 1`,
    [runId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const filters = parseJson(row.persona_filters);
  return {
    studyId: row.study_id,
    publicId: row.public_id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    userPublicId: row.user_public_id,
    runId: row.run_id,
    runStatus: row.run_status,
    runStartedAt: row.run_started_at,
    brief: row.brief,
    studyType: row.study_type,
    framework: row.framework,
    methods: parseJson(row.methods),
    audience: filters.audience ?? "由研究 Brief 确定的目标人群",
    personaCount: row.persona_count,
    estimatedTokens: Number(row.estimated_tokens),
    workflowType: row.workflow_type,
    workflowVersion: row.workflow_version,
    workflowTaskGraph: row.workflow_task_graph ? parseJson(row.workflow_task_graph) : null,
    gptResearcherReportType: row.gpt_researcher_report_type,
  };
}

async function ensureTasks(study: HarnessStudy) {
  const database = await getDatabase();
  const definitions = study.workflowTaskGraph?.length ? study.workflowTaskGraph : createResearchTaskPlan(study);
  await database.transaction(async (transaction) => {
    await lockRunBuiltInSkills({
      queryable: transaction,
      workspaceId: study.workspaceId,
      studyId: study.studyId,
      runId: study.runId,
      skills: definitions.map((definition) => ({
        slug: definition.toolName,
        version: researchTools[definition.toolName].version,
      })),
    });
    const existing = await transaction.query<{ count: string }>(
      "select count(*)::text as count from study_tasks where run_id = $1",
      [study.runId],
    );
    if (Number(existing.rows[0]?.count ?? 0) === 0) {
      for (const [position, definition] of definitions.entries()) {
        await transaction.query(
          `insert into study_tasks (
             public_id, study_id, run_id, position, task_key, title, tool_name, depends_on, input, timeout_seconds
           ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
          [
            createPublicId("tsk"), study.studyId, study.runId, position, definition.key,
            definition.title, definition.toolName, JSON.stringify(definition.dependsOn),
            JSON.stringify(definition.input ?? {}), getRuntimeLimits().taskTimeoutSeconds,
          ],
        );
      }
    }
    await transaction.query(
      `insert into study_run_checkpoints (run_id, study_id)
       values ($1, $2)
       on conflict (run_id) do nothing`,
      [study.runId, study.studyId],
    );
  });
}

async function loadTasks(runId: string): Promise<StoredTask[]> {
  const database = await getDatabase();
  const result = await database.query<{
    id: string;
    public_id: string;
    position: number;
    task_key: string;
    title: string;
    tool_name: ResearchToolName;
    status: TaskStatus;
    depends_on: string[] | string;
    input: Record<string, unknown> | string;
    output: Record<string, unknown> | string;
    attempt: number;
    max_attempts: number;
    next_attempt_at: string | null;
    waiting_reason: string | null;
    timeout_seconds: number;
    origin: "planned" | "dynamic";
    generation: number;
  }>(
    `select id::text as id, public_id, position, task_key, title, tool_name, status,
            depends_on, input, output, attempt, max_attempts, next_attempt_at, waiting_reason, timeout_seconds, origin, generation
     from study_tasks where run_id = $1 order by position, id`,
    [runId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    position: row.position,
    key: row.task_key,
    title: row.title,
    toolName: row.tool_name,
    status: row.status,
    dependsOn: parseJson(row.depends_on),
    input: parseJson(row.input),
    output: parseJson(row.output),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    waitingReason: row.waiting_reason,
    timeoutSeconds: row.timeout_seconds,
    origin: row.origin,
    generation: row.generation,
  }));
}

function maxAgentDynamicTasks(strategy: StrategyAssignment) {
  const configured = Number(strategy.config.maxDynamicTasks ?? 2);
  return Number.isFinite(configured) ? Math.max(0, Math.min(8, configured)) : 2;
}

function allowedAgentTaskTemplates(strategy: StrategyAssignment) {
  return getAllowedResearchAgentTaskTemplates(strategy.config);
}

export async function appendResearchAgentDynamicTasks(input: {
  database: Database;
  study: HarnessStudy;
  tasks: StoredTask[];
  action: Extract<AgentAction, { type: "replan" }>;
  strategy: StrategyAssignment;
  decision: { responseId: string; model: string; promptVersion: string };
}) {
  const existingDynamicCount = input.tasks.filter((task) => task.origin === "dynamic").length;
  const maxDynamicTasks = maxAgentDynamicTasks(input.strategy);
  const requested = input.action.requestedTasks;
  if (existingDynamicCount + requested.length > maxDynamicTasks) {
    return { accepted: false as const, reason: "dynamic_task_limit_reached" };
  }
  const reportGate = input.tasks.find((task) => (
    task.status === "pending" && task.toolName === "generateReport"
  ));
  if (!reportGate) return { accepted: false as const, reason: "report_gate_not_open" };

  const existingKeys = new Set(input.tasks.map((task) => task.key));
  const requestedKeys = new Set<string>();
  const definitions: ResearchTaskDefinition[] = [];
  const allowedTemplates = allowedAgentTaskTemplates(input.strategy);
  for (const candidate of requested) {
    if (!/^[a-z][a-z0-9_.-]{1,159}$/.test(candidate.key)) {
      return { accepted: false as const, reason: "task_key_invalid" };
    }
    if (existingKeys.has(candidate.key) || requestedKeys.has(candidate.key)) {
      return { accepted: false as const, reason: "task_key_conflict" };
    }
    const toolName = candidate.toolName as ResearchToolName;
    const tool = researchTools[toolName];
    if (!tool || !agentDynamicToolNames.includes(toolName)) {
      return { accepted: false as const, reason: "tool_not_allowed" };
    }
    const parsedInput = tool.inputSchema.safeParse(candidate.input);
    if (!parsedInput.success) return { accepted: false as const, reason: "tool_input_invalid" };
    const templateValidation = validateResearchAgentTaskTemplate({
      template: candidate.template,
      toolName,
      taskInput: candidate.input,
      allowedTemplates,
    });
    if (!templateValidation.accepted) return { accepted: false as const, reason: templateValidation.reason };
    for (const dependency of candidate.dependsOn) {
      if (dependency === candidate.key || (!existingKeys.has(dependency) && !requestedKeys.has(dependency))) {
        return { accepted: false as const, reason: "dependency_unknown" };
      }
      const existingDependency = input.tasks.find((task) => task.key === dependency);
      if (existingDependency && !["completed", "skipped"].includes(existingDependency.status)) {
        return { accepted: false as const, reason: "dependency_not_completed" };
      }
    }
    requestedKeys.add(candidate.key);
    definitions.push({
      key: candidate.key,
      title: candidate.title,
      toolName,
      template: templateValidation.template.name,
      dependsOn: candidate.dependsOn,
      input: parsedInput.data as Record<string, unknown>,
    });
  }

  try {
    return await input.database.transaction(async (transaction) => {
      await transaction.query("select id from study_runs where id = $1 for update", [input.study.runId]);
      await lockRunBuiltInSkills({
        queryable: transaction,
        workspaceId: input.study.workspaceId,
        studyId: input.study.studyId,
        runId: input.study.runId,
        skills: definitions.map((definition) => ({
          slug: definition.toolName,
          version: researchTools[definition.toolName].version,
        })),
      });
      const sequence = await transaction.query<{ value: number }>(
        "select coalesce(max(sequence), -1)::int + 1 as value from reasoning_decisions where run_id = $1",
        [input.study.runId],
      );
      const recordedDecision = await transaction.query<{ id: string; public_id: string }>(
        `insert into reasoning_decisions (
           public_id, workspace_id, study_id, run_id, decision_key, sequence, trigger_type,
           policy_version, input_snapshot, artifact_refs, evidence_refs, budget_snapshot,
           metrics, chosen_action, reason
         ) values ($1, $2, $3, $4, $5, $6, 'agent_controller', $7, $8::jsonb,
                   '[]'::jsonb, '[]'::jsonb, $9::jsonb, '{}'::jsonb, $10::jsonb, $11)
         returning id::text as id, public_id`,
        [
          createPublicId("rsn"), input.study.workspaceId, input.study.studyId, input.study.runId,
          `agent:${input.decision.responseId}`, sequence.rows[0].value, input.decision.promptVersion,
          JSON.stringify({ action: input.action, taskKeys: input.tasks.map((task) => task.key), model: input.decision.model }),
          JSON.stringify({ maxDynamicTasks, existingDynamicCount }),
          JSON.stringify({
            type: "replan",
            requestedTaskKeys: definitions.map((definition) => definition.key),
            templates: definitions.map((definition) => ({ key: definition.key, template: definition.template, version: RESEARCH_AGENT_TASK_TEMPLATE_VERSION })),
          }),
          input.action.reason,
        ],
      );
      await transaction.query(
        `insert into reasoning_decision_candidates (
           decision_id, position, action_type, score, allowed, selected, payload, rejection_reasons
         ) values ($1, 0, 'replan', 1, true, true, $2::jsonb, '[]'::jsonb)`,
        [recordedDecision.rows[0].id, JSON.stringify({
          requestedTaskKeys: definitions.map((definition) => definition.key),
          templates: definitions.map((definition) => ({ key: definition.key, template: definition.template, version: RESEARCH_AGENT_TASK_TEMPLATE_VERSION })),
        })],
      );
      const mutation = await appendGovernedDynamicTasks({
        queryable: transaction,
        studyId: input.study.studyId,
        runId: input.study.runId,
        definitions: definitions.map((definition) => ({ ...definition, input: definition.input ?? {} })),
        timeoutSeconds: getRuntimeLimits().taskTimeoutSeconds,
        maxDynamicTasks,
        gateTaskKey: reportGate.key,
        allowedToolNames: agentDynamicToolNames,
        reasoningDecisionId: recordedDecision.rows[0].id,
        policyVersion: input.decision.promptVersion,
        source: "agent_controller",
      });
      await transaction.query(
        `insert into study_events (study_id, run_id, event_type, payload)
         values ($1, $2, 'agent.replan.accepted', $3::jsonb),
                ($1, $2, 'agent.tasks.added', $4::jsonb),
                ($1, $2, 'reasoning.decision.recorded', $5::jsonb)`,
        [
          input.study.studyId, input.study.runId,
          JSON.stringify({ reason: input.action.reason, taskKeys: mutation.taskKeys, generation: mutation.generation, decisionPublicId: recordedDecision.rows[0].public_id, templates: definitions.map((definition) => ({ key: definition.key, template: definition.template, version: RESEARCH_AGENT_TASK_TEMPLATE_VERSION })) }),
          JSON.stringify({ taskKeys: mutation.taskKeys, origin: "dynamic", generation: mutation.generation, templates: definitions.map((definition) => ({ key: definition.key, template: definition.template, version: RESEARCH_AGENT_TASK_TEMPLATE_VERSION })) }),
          JSON.stringify({ decisionPublicId: recordedDecision.rows[0].public_id, chosenAction: "replan", policyVersion: input.decision.promptVersion, reason: input.action.reason }),
        ],
      );
      return { accepted: true as const, reason: null, taskKeys: mutation.taskKeys };
    });
  } catch (error) {
    const reason = dynamicTaskMutationRejectionReason(error);
    if (reason) return { accepted: false as const, reason };
    throw error;
  }
}

export async function pauseResearchAgentForInput(input: {
  database: Database;
  study: HarnessStudy;
  task: StoredTask;
  action: Extract<AgentAction, { type: "ask_user" }>;
}) {
  const requestPayload = {
    title: "研究需要你的确认",
    description: input.action.question,
    fields: input.action.fields,
  };
  return input.database.transaction(async (transaction) => {
    const paused = await transaction.query<{ id: string }>(
      `update study_tasks set status = 'waiting_input', error_message = $2,
              waiting_reason = 'AGENT_INPUT_REQUIRED', waiting_payload = $3::jsonb,
              waiting_since = now(), finished_at = now(), updated_at = now()
       where id = $1 and status = 'pending'
       returning id::text as id`,
      [input.task.id, input.action.question, JSON.stringify(requestPayload)],
    );
    if (!paused.rows[0]) throw new Error("AGENT_INPUT_TASK_NOT_READY");
    await transaction.query(
      `insert into study_task_inputs (public_id, workspace_id, study_id, run_id, task_id, request_payload)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (task_id) where (status = 'pending') do update set request_payload = excluded.request_payload,
         requested_at = now(), response_payload = null`,
      [createPublicId("tin"), input.study.workspaceId, input.study.studyId, input.study.runId, input.task.id, JSON.stringify(requestPayload)],
    );
    await transaction.query(
      "update study_runs set status = 'waiting_input', error_message = $2 where id = $1",
      [input.study.runId, input.action.question],
    );
    await transaction.query(
      "update studies set status = 'waiting_input', current_stage = 'execution', updated_at = now() where id = $1",
      [input.study.studyId],
    );
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, 'agent.run.waiting_input', $3::jsonb),
              ($1, $2, $4, $3::jsonb)`,
      [input.study.studyId, input.study.runId, JSON.stringify({ taskKey: input.task.key, taskPublicId: input.task.publicId, question: input.action.question, fields: input.action.fields }), `task.${input.task.key}.waiting_input`],
    );
  });
}

async function loadCheckpoint(runId: string): Promise<HarnessState> {
  const database = await getDatabase();
  const result = await database.query<{ state: HarnessState | string }>(
    "select state from study_run_checkpoints where run_id = $1",
    [runId],
  );
  return result.rows[0] ? parseJson(result.rows[0].state) : {};
}

async function isRunCancellationRequested(runId: string) {
  const database = await getDatabase();
  const result = await database.query<{ cancelled: boolean }>(
    `select (cancel_requested_at is not null or status = 'cancelled') as cancelled
     from study_runs where id = $1 limit 1`,
    [runId],
  );
  return result.rows[0]?.cancelled ?? true;
}

async function markRunCancelled(study: HarnessStudy) {
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    await transaction.query(
      `update study_runs set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()),
              finished_at = coalesce(finished_at, now()), error_message = null
       where id = $1`,
      [study.runId],
    );
    await transaction.query(
      "update studies set status = 'cancelled', updated_at = now() where id = $1",
      [study.studyId],
    );
    await transaction.query(
      `update study_tasks set status = case when status = 'running' then 'failed' else 'skipped' end,
              error_message = 'RUNTIME_CANCELLED', finished_at = coalesce(finished_at, now()), updated_at = now()
       where run_id = $1 and status in ('pending', 'running', 'waiting_input')`,
      [study.runId],
    );
    await transaction.query(
      `update study_job_queue set status = 'cancelled', lease_owner = null, lease_expires_at = null, updated_at = now()
       where run_id = $1 and status in ('queued', 'leased')`,
      [study.runId],
    );
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, 'run.cancelled', '{}'::jsonb)`,
      [study.studyId, study.runId],
    );
  });
}

function abortError(message: string) {
  return new DOMException(message, "AbortError");
}

function waitForRetry(signal: AbortSignal, delayMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? abortError("RUNTIME_CANCELLED"));
    }, { once: true });
  });
}

function sanitizePostgresJsonValue<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "") as T;
  if (Array.isArray(value)) return value.map(sanitizePostgresJsonValue) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizePostgresJsonValue(item)]),
  ) as T;
}

export function resolveResearchTaskRuntimePolicy(input: {
  toolName: ResearchToolName;
  persistedTimeoutSeconds: number;
  strategyConfig?: Record<string, unknown>;
}) {
  const strategyOverride = input.strategyConfig
    && Object.prototype.hasOwnProperty.call(input.strategyConfig, "taskTimeoutSeconds")
    ? Number(input.strategyConfig.taskTimeoutSeconds)
    : null;
  const configuredTimeout = strategyOverride !== null && Number.isFinite(strategyOverride)
    ? strategyOverride
    : input.persistedTimeoutSeconds;
  const usesGptResearcher = input.toolName === "deepResearch" && isGptResearcherEnabled();
  const timeoutSeconds = usesGptResearcher && strategyOverride === null
    ? Math.max(configuredTimeout, getGptResearcherRuntimeLimits().taskTimeoutSeconds)
    : configuredTimeout;
  return {
    timeoutSeconds: Math.max(15, Math.min(3600, timeoutSeconds)),
    researchEngine: usesGptResearcher ? "gpt-researcher" as const : "local" as const,
  };
}

async function executeTask(input: {
  study: HarnessStudy;
  task: StoredTask;
  state: HarnessState;
  context: ContextSnapshot;
  strategy: StrategyAssignment;
  runSignal: AbortSignal;
}) {
  if (input.runSignal.aborted || await isRunCancellationRequested(input.study.runId)) {
    throw abortError("RUNTIME_CANCELLED");
  }
  const tool = resolveBuiltInSkill(researchTools, input.task.toolName) as ResearchTool<unknown, unknown>;
  const binding = await getRunSkillBinding(input.study.runId, input.task.toolName);
  if (!binding) throw new Error(`SKILL_BINDING_MISSING:${input.task.toolName}`);
  const database = await getDatabase();
  const providerStage = typeof tool.providerStage === "function"
    ? tool.providerStage(input.state)
    : tool.providerStage;
  const providerRoute = providerStage
    ? await database.transaction((transaction) => resolveProviderRoute({
        queryable: transaction,
        workspaceId: input.study.workspaceId,
        runId: input.study.runId,
        taskId: input.task.id,
        stage: providerStage,
        subjectKey: `study:${input.study.publicId}:task:${input.task.key}:attempt:${input.task.attempt + 1}`,
      }))
    : null;
  const providerStatus = providerStage
    ? providerRoute
      ? {
          stage: providerStage,
          providerName: providerRoute.override.providerName,
          model: providerRoute.override.model,
          protocol: providerRoute.override.protocol,
          configured: true,
          requiredVariable: providerRoute.override.providerName === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY",
        }
      : getProviderStageStatus(providerStage)
    : null;
  const providerStartedAt = Date.now();
  const runtimePolicy = resolveResearchTaskRuntimePolicy({
    toolName: input.task.toolName,
    persistedTimeoutSeconds: input.task.timeoutSeconds,
    strategyConfig: input.strategy.config,
  });
  const timeoutSeconds = runtimePolicy.timeoutSeconds;
  const timeout = timeoutSeconds * 1000;
  const controller = new AbortController();
  const abortFromRun = () => controller.abort(input.runSignal.reason ?? abortError("RUNTIME_CANCELLED"));
  input.runSignal.addEventListener("abort", abortFromRun, { once: true });
  const timer = setTimeout(() => controller.abort(abortError(`RUNTIME_TASK_TIMEOUT:${timeoutSeconds}`)), timeout);
  const invocation = await beginInvocation(input.study, input.task, binding, input.context.retrievalId);
  await appendEvent(database, input.study.studyId, input.study.runId, `task.${input.task.key}.started`, {
    taskKey: input.task.key,
    taskPublicId: input.task.publicId,
    toolName: input.task.toolName,
    skillVersion: tool.version,
    skillBindingPublicId: binding.publicId,
    executorType: binding.executorType,
    contextRetrievalId: input.context.retrievalPublicId,
    invocationId: invocation.invocationPublicId,
    strategyVersion: input.strategy.strategyVersion,
    timeoutSeconds,
    researchEngine: runtimePolicy.researchEngine,
    ...(providerStatus ? { providerStage, provider: providerStatus.providerName, model: providerStatus.model } : {}),
  });
  await appendEvent(database, input.study.studyId, input.study.runId, "tool.call.started", {
    taskKey: input.task.key,
    taskPublicId: input.task.publicId,
    toolName: input.task.toolName,
    skillVersion: tool.version,
    skillBindingPublicId: binding.publicId,
    executorType: binding.executorType,
    contextRetrievalId: input.context.retrievalPublicId,
    invocationId: invocation.invocationPublicId,
    arguments: input.task.input,
    timeoutSeconds,
    researchEngine: runtimePolicy.researchEngine,
    ...(providerStatus ? { providerStage, provider: providerStatus.providerName, model: providerStatus.model } : {}),
  });
  const progressStartedAt = Date.now();
  let progressStopped = false;
  let progressWrites = Promise.resolve();
  const progressTimer = setInterval(() => {
    progressWrites = progressWrites
      .then(() => appendEvent(database, input.study.studyId, input.study.runId, "tool.call.progress", {
        taskKey: input.task.key,
        taskPublicId: input.task.publicId,
        toolName: input.task.toolName,
        invocationId: invocation.invocationPublicId,
        elapsedMs: Date.now() - progressStartedAt,
        phase: providerStage ? "model" : "tool",
        ...(providerStatus ? { providerStage, provider: providerStatus.providerName, model: providerStatus.model } : {}),
      }))
      .catch(() => undefined);
  }, 2_500);
  progressTimer.unref?.();
  const stopProgress = async () => {
    if (progressStopped) return;
    progressStopped = true;
    clearInterval(progressTimer);
    await progressWrites;
  };
  try {
    if (!binding.enabledAtLock) throw new Error(`SKILL_DISABLED:${binding.slug}`);
    if (binding.version !== tool.version) {
      throw new Error(`SKILL_VERSION_UNAVAILABLE:${binding.slug}@${binding.version}`);
    }
    if (providerStage) {
      const rateAccepted = await consumeProviderRateToken(
        database,
        providerStatus?.providerName ?? getProviderStageStatus(providerStage).providerName,
        input.study.workspaceId,
      );
      if (!rateAccepted) throw new Error("RUNTIME_RATE_LIMITED");
    }
    const parsedInput = tool.inputSchema.parse(input.task.input);
    const emitProgress = async (event: { type: string; payload?: Record<string, unknown> }) => {
      await appendEvent(database, input.study.studyId, input.study.runId, event.type, event.payload ?? {});
    };
    const execute = () => tool.execute({
        study: input.study,
        task: {
          key: input.task.key,
          publicId: input.task.publicId,
          attempt: invocation.attempt,
          toolName: input.task.toolName,
        },
        state: input.state,
        context: input.context,
        signal: controller.signal,
        strategy: input.strategy,
        emitProgress,
      }, parsedInput);
    const result = providerRoute
      ? await withProviderRoute(providerRoute.override, execute)
      : await execute();
    if (controller.signal.aborted || await isRunCancellationRequested(input.study.runId)) {
      throw controller.signal.reason ?? abortError("RUNTIME_CANCELLED");
    }
    const output = sanitizePostgresJsonValue(tool.outputSchema.parse(result.output));
    if (providerRoute) {
      const outputRecord = output && typeof output === "object" ? output as Record<string, unknown> : {};
      await finishProviderRouteDecision({
        queryable: database,
        decisionId: providerRoute.decisionId,
        usage: outputRecord.usage,
        latencyMs: Date.now() - providerStartedAt,
        qualityScore: providerStage === "judge" && typeof outputRecord.score === "number" ? outputRecord.score : null,
      });
    }
    const eventPayload = sanitizePostgresJsonValue({
      ...result.eventPayload,
      ...(providerStatus ? { providerStage, provider: providerStatus.providerName, model: providerStatus.model } : {}),
    });
    await stopProgress();
    await completeInvocation({
      study: input.study,
      task: input.task,
      invocationId: invocation.invocationId,
      attempt: invocation.attempt,
      output,
      artifactType: result.artifactType,
      artifactTitle: result.artifactTitle,
      eventPayload,
    });
    return { kind: "completed" as const, key: input.task.key, output };
  } catch (error) {
    await stopProgress();
    if (providerRoute) {
      await finishProviderRouteDecision({
        queryable: database,
        decisionId: providerRoute.decisionId,
        latencyMs: Date.now() - providerStartedAt,
        errorCode: describeOpenAIError(error).code ?? "PROVIDER_CALL_FAILED",
      });
    }
    const resolution = await failInvocation({
      study: input.study,
      task: input.task,
      invocationId: invocation.invocationId,
      attempt: invocation.attempt,
      error,
    });
    if (resolution === "retry" || resolution === "waiting_input") return { kind: resolution, key: input.task.key };
    if (resolution === "cancelled") throw error;
    const failure = classifyTaskError(error);
    throw new TaskTerminalFailure(failure.message, failure.code);
  } finally {
    await stopProgress();
    clearTimeout(timer);
    input.runSignal.removeEventListener("abort", abortFromRun);
  }
}

async function beginInvocation(
  study: HarnessStudy,
  task: StoredTask,
  binding: NonNullable<Awaited<ReturnType<typeof getRunSkillBinding>>>,
  contextRetrievalId: string | null,
) {
  const database = await getDatabase();
  return database.transaction((transaction) => startTaskAttempt(transaction, {
    studyId: study.studyId,
    runId: study.runId,
    taskId: task.id,
    taskKey: task.key,
    toolName: task.toolName,
    skillVersion: binding.version,
    skillBindingId: binding.id,
    executorType: binding.executorType,
    contextRetrievalId,
    arguments: task.input,
  }));
}

async function completeInvocation(input: {
  study: HarnessStudy;
  task: StoredTask;
  invocationId: string;
  attempt: number;
  output: unknown;
  artifactType: string;
  artifactTitle: string;
  eventPayload: Record<string, unknown>;
}) {
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    await transaction.query(
      `update study_tool_invocations
       set status = 'completed', result = $2::jsonb, response_hash = $3, finished_at = now()
       where id = $1`,
      [input.invocationId, JSON.stringify(input.output), hashJson(input.output)],
    );
    await transaction.query(
      `update study_task_attempts set status = 'completed', error_class = null, error_code = null,
              error_message = null, retryable = false, finished_at = now()
       where task_id = $1 and attempt = $2`,
      [input.task.id, input.attempt],
    );
    await transaction.query(
      `update study_tasks
       set status = 'completed', output = $2::jsonb, error_message = null, next_attempt_at = null,
           last_error_code = null, last_error_class = null, retryable = false,
           waiting_reason = null, waiting_payload = null, waiting_since = null,
           finished_at = now(), updated_at = now()
       where id = $1`,
      [input.task.id, JSON.stringify(input.output)],
    );
    await transaction.query(
      `insert into study_artifacts (
         public_id, study_id, run_id, task_id, artifact_type, title, content
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (run_id, task_id, artifact_type) do update set
         title = excluded.title, content = excluded.content, updated_at = now()`,
      [
        createPublicId("art"), input.study.studyId, input.study.runId, input.task.id,
        input.artifactType, input.artifactTitle, JSON.stringify(input.output),
      ],
    );
    await transaction.query(
      `update study_run_checkpoints
       set cursor = greatest(cursor, $2),
           state = jsonb_set(state, array[$3], $4::jsonb, true), updated_at = now()
       where run_id = $1`,
      [input.study.runId, input.task.position + 1, input.task.key, JSON.stringify(input.output)],
    );
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, $3, $4::jsonb),
              ($1, $2, 'tool.call.completed', $5::jsonb),
              ($1, $2, 'todo.updated', $6::jsonb)`,
      [
        input.study.studyId,
        input.study.runId,
        `task.${input.task.key}.completed`,
        JSON.stringify(input.eventPayload),
        JSON.stringify({
          taskKey: input.task.key,
          taskPublicId: input.task.publicId,
          toolName: input.task.toolName,
          invocationId: input.invocationId,
          ...input.eventPayload,
        }),
        JSON.stringify({ taskKey: input.task.key, completed: true }),
      ],
    );
  });
}

async function failInvocation(input: {
  study: HarnessStudy;
  task: StoredTask;
  invocationId: string;
  attempt: number;
  error: unknown;
}) {
  const failure = classifyTaskError(input.error);
  const resolution = failure.disposition === "retry" && input.attempt >= input.task.maxAttempts
    ? "terminal" as const
    : failure.disposition;
  const taskStatus = resolution === "retry" || resolution === "cancelled" ? "pending" : resolution === "waiting_input" ? "waiting_input" : "failed";
  const invocationStatus = resolution === "waiting_input" ? "waiting_input" : resolution === "cancelled" ? "cancelled" : "failed";
  const attemptStatus = resolution === "waiting_input" ? "waiting_input" : resolution === "cancelled" ? "cancelled" : "failed";
  const delaySeconds = resolution === "retry" ? taskRetryDelaySeconds(input.attempt) : null;
  const database = await getDatabase();
  await database.transaction(async (transaction) => {
    await transaction.query(
      `update study_tool_invocations set status = $2, error_message = $3, finished_at = now()
       where id = $1`,
      [input.invocationId, invocationStatus, failure.message],
    );
    await transaction.query(
      `update study_task_attempts set status = $3, error_class = $4, error_code = $5,
              error_message = $6, retryable = $7, finished_at = now()
       where task_id = $1 and attempt = $2`,
      [input.task.id, input.attempt, attemptStatus, failure.className, failure.code, failure.message, resolution === "retry"],
    );
    await transaction.query(
      `update study_tasks set status = $2, error_message = $3, last_error_code = $4, last_error_class = $5,
              retryable = $6, next_attempt_at = case when $7::integer is null then null else now() + ($7 * interval '1 second') end,
              waiting_reason = $8, waiting_payload = $9::jsonb,
              waiting_since = case when $2 = 'waiting_input' then now() else null end,
              finished_at = now(), updated_at = now()
       where id = $1`,
      [
        input.task.id, taskStatus, failure.message, failure.code, failure.className, resolution === "retry",
        delaySeconds, resolution === "waiting_input" ? failure.message : null,
        JSON.stringify(resolution === "waiting_input" ? failure.inputRequest ?? {} : {}),
      ],
    );
    if (resolution === "waiting_input") {
      await transaction.query(
        `insert into study_task_inputs (public_id, workspace_id, study_id, run_id, task_id, request_payload)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (task_id) where (status = 'pending') do update set request_payload = excluded.request_payload,
           requested_at = now(), response_payload = null`,
        [createPublicId("tin"), input.study.workspaceId, input.study.studyId, input.study.runId, input.task.id, JSON.stringify(failure.inputRequest ?? {})],
      );
      await transaction.query("update study_runs set status = 'waiting_input', error_message = $2 where id = $1", [input.study.runId, failure.message]);
      await transaction.query("update studies set status = 'waiting_input', current_stage = 'execution', updated_at = now() where id = $1", [input.study.studyId]);
    }
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, $3, $4::jsonb), ($1, $2, 'tool.call.failed', $4::jsonb)`,
      [
        input.study.studyId,
        input.study.runId,
        resolution === "retry" ? `task.${input.task.key}.retry_scheduled` : resolution === "waiting_input" ? `task.${input.task.key}.waiting_input` : `task.${input.task.key}.failed`,
        JSON.stringify({
          taskKey: input.task.key,
          taskPublicId: input.task.publicId,
          toolName: input.task.toolName,
          invocationId: input.invocationId,
          message: failure.message,
          errorClass: failure.className,
          errorCode: failure.code,
          retryable: resolution === "retry",
          nextAttemptInSeconds: delaySeconds,
        }),
      ],
    );
  });
  return resolution;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderReportHtml(report: ResearchReport) {
  const findings = report.findings.map((finding) => (
    `<section><h2>${escapeHtml(finding.title)}</h2><p>${escapeHtml(finding.insight)}</p>`
      + `<h3>证据</h3><p>${escapeHtml(finding.evidence)}</p>`
      + `<h3>业务含义</h3><p>${escapeHtml(finding.implication)}</p></section>`
  )).join("");
  return `<article><h1>${escapeHtml(report.title)}</h1><p>${escapeHtml(report.executiveSummary)}</p>${findings}</article>`;
}

function totalTokens(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if ("total_tokens" in value && typeof value.total_tokens === "number") return value.total_tokens;
  if ("totalTokens" in value && typeof value.totalTokens === "number") return value.totalTokens;
  return 0;
}

function getRunProviderSummary() {
  const stages = (["research", "reasoning", "report", "judge"] as const).map(getProviderStageStatus);
  const providers = [...new Set(stages.map((stage) => stage.providerName))];
  const models = [...new Set(stages.map((stage) => stage.model))];
  return {
    provider: providers.length === 1 ? providers[0] : `mixed:${providers.join("+")}`,
    model: models.join(" + "),
  };
}

async function materializeStudy(study: HarnessStudy, state: HarnessState) {
  const database = await getDatabase();
  const personaResult = personaPanelSchema.safeParse(state.personas);
  const panelResult = personaPanelSchema.shape.panel.safeParse(state.panel);
  const batchOne = z.array(interviewSchema).safeParse(state.interviews_one);
  const batchTwo = z.array(interviewSchema).safeParse(state.interviews_two);
  const finalizedReportResult = finalReportSchema.safeParse(state.final_report);
  const draftReportResult = reportSchema.safeParse(state.report);
  const reportResult = finalizedReportResult.success ? finalizedReportResult : draftReportResult;

  await database.transaction(async (transaction) => {
    const personaIdsByName = new Map<string, string>();
    const personaContextCandidates: Array<{ publicId: string; name: string; profile: unknown }> = [];
    if (personaResult.success) {
      const compositionByName = new Map(personaResult.data.composition.map((item) => [item.name, item]));
      for (const persona of personaResult.data.personas) {
        const composition = compositionByName.get(persona.name);
        if (composition?.source === "reused" && composition.publicId) {
          const reused = await transaction.query<{ id: string }>(
            `select id::text as id from study_personas
             where public_id = $1 and workspace_id = $2 limit 1`,
            [composition.publicId, study.workspaceId],
          );
          if (reused.rows[0]) {
            personaIdsByName.set(persona.name, reused.rows[0].id);
            continue;
          }
        }
        const inserted = await transaction.query<{ id: string; public_id: string }>(
          `insert into study_personas (
             public_id, workspace_id, created_by, study_id, run_id, name, archetype, profile, retention_status
           ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending')
           returning id::text as id, public_id`,
          [
            createPublicId("per"), study.workspaceId, study.createdBy, study.studyId, study.runId,
            persona.name, persona.archetype, JSON.stringify(persona),
          ],
        );
        personaIdsByName.set(persona.name, inserted.rows[0].id);
        personaContextCandidates.push({ publicId: inserted.rows[0].public_id, name: persona.name, profile: persona });
      }

      const panel = panelResult.success ? panelResult.data : personaResult.data.panel;
      const insertedPanel = await transaction.query<{ id: string }>(
        `insert into study_panels (public_id, study_id, run_id, title, description)
         values ($1, $2, $3, $4, $5) returning id::text as id`,
        [createPublicId("pnl"), study.studyId, study.runId, panel.title, panel.description],
      );
      for (const [position, persona] of personaResult.data.personas.entries()) {
        const personaId = personaIdsByName.get(persona.name);
        if (!personaId) continue;
        await transaction.query(
          "insert into study_panel_members (panel_id, persona_id, position) values ($1, $2, $3)",
          [insertedPanel.rows[0].id, personaId, position],
        );
      }

      const interviews = [
        ...(batchOne.success ? batchOne.data : []),
        ...(batchTwo.success ? batchTwo.data : []),
      ];
      for (const interview of interviews) {
        const personaId = personaIdsByName.get(interview.personaName);
        if (!personaId) continue;
        await transaction.query(
          `insert into study_interviews (study_id, run_id, persona_id, batch, objective, content)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [study.studyId, study.runId, personaId, interview.batch, interview.objective, JSON.stringify(interview)],
        );
      }
    }

    if (reportResult.success) {
      const content = { ...reportResult.data.report, citations: reportResult.data.citations };
      const storedReport = await transaction.query<{ id: string; public_id: string }>(
        `insert into reports (public_id, study_id, title, description, content_html, content_json)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (study_id) do update set
           title = excluded.title, description = excluded.description,
           content_html = excluded.content_html, content_json = excluded.content_json,
           generated_at = now()
         returning id::text as id, public_id`,
        [
          createPublicId("rpt"), study.studyId, reportResult.data.report.title,
          reportResult.data.report.executiveSummary, renderReportHtml(reportResult.data.report),
          JSON.stringify(content),
        ],
      );
      const research = mergedResearchState(state);
      const discussion = discussionSchema.safeParse(state.discussion);
      await materializeReportEvidenceGraph(transaction, {
        workspaceId: study.workspaceId,
        studyId: study.studyId,
        runId: study.runId,
        reportId: storedReport.rows[0].id,
        report: reportResult.data.report,
        citations: reportResult.data.citations,
        catalog: buildReportEvidenceCatalog({
          sources: research.sources,
          panelResearch: personaResult.success ? {
            panel: panelResult.success ? panelResult.data : personaResult.data.panel,
            personas: personaResult.data.personas,
            interviews: [
              ...(batchOne.success ? batchOne.data : []),
              ...(batchTwo.success ? batchTwo.data : []),
            ],
            validation: validationSchema.parse(state.validation),
          } : undefined,
          discussion: discussion.success ? discussion.data : undefined,
        }),
        provider: reportResult.data.provider,
        providerModel: reportResult.data.model,
        providerResponseId: reportResult.data.responseId,
        promptVersion: reportResult.data.promptVersion,
      });
      await groundStudyPersonasFromEvidence(transaction, {
        workspaceId: study.workspaceId,
        studyId: study.studyId,
        runId: study.runId,
        personas: personaContextCandidates.map((persona) => ({ publicId: persona.publicId, name: persona.name })),
      });
      await proposeStudyContextCandidates(transaction, {
        workspaceId: study.workspaceId,
        userId: study.createdBy,
        studyPublicId: study.publicId,
        report: {
          publicId: storedReport.rows[0].public_id,
          title: reportResult.data.report.title,
          executiveSummary: reportResult.data.report.executiveSummary,
          content,
        },
        personas: personaContextCandidates,
        study: {
          brief: study.brief,
          studyType: study.studyType,
          framework: study.framework,
          methods: study.methods,
          audience: study.audience,
          personaCount: study.personaCount,
          workflowType: study.workflowType,
          workflowVersion: study.workflowVersion,
          taskGraph: study.workflowTaskGraph ?? createResearchTaskPlan(study),
        },
      });
    }

    const usage = Object.values(state).reduce<number>((sum, item) => {
      if (!item || typeof item !== "object" || !("usage" in item)) return sum;
      return sum + totalTokens(item.usage);
    }, 0);
    const routedProviders = await transaction.query<{ provider_name: string; model: string }>(
      `select distinct provider_name, model from provider_route_decisions
       where run_id = $1 and status = 'completed' order by provider_name, model`,
      [study.runId],
    );
    const provider = routedProviders.rows.length
      ? {
          provider: routedProviders.rows.length === 1
            ? routedProviders.rows[0].provider_name
            : `mixed:${[...new Set(routedProviders.rows.map((row) => row.provider_name))].join("+")}`,
          model: routedProviders.rows.map((row) => row.model).join(" + "),
        }
      : getRunProviderSummary();
    await transaction.query(
      `update study_runs set status = 'completed', provider = $2, provider_model = $3,
              usage = $4::jsonb, finished_at = now(), error_message = null
       where id = $1`,
      [study.runId, provider.provider, provider.model, JSON.stringify({ total_tokens: usage })],
    );
    await transaction.query(
      `update studies set status = 'completed', current_stage = $2, consumed_tokens = $3, updated_at = now()
       where id = $1`,
      [study.studyId, reportResult.success ? "report" : "execution", usage],
    );
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, 'research.completed', $3::jsonb)`,
      [
        study.studyId,
        study.runId,
        JSON.stringify({
          taskCount: Object.keys(state).length,
          reportGenerated: reportResult.success,
          personaCount: personaResult.success ? personaResult.data.personas.length : 0,
        }),
      ],
    );
  });
}

export async function runStudyHarness(runId: string, options: {
  executionSource?: "worker" | "local_harness_probe";
} = {}) {
  const study = await loadHarnessStudy(runId);
  if (!study) return "not_found" as const;
  if (study.runStatus === "completed") return "completed" as const;
  const resuming = study.runStartedAt !== null;
  await ensureTasks(study);
  const database = await getDatabase();
  const recoveredTasks = await database.transaction((transaction) => recoverInterruptedTasks(transaction, runId));
  const provider = getRunProviderSummary();
  const strategy = await database.transaction(async (transaction) => {
    const assigned = await assignActiveStrategy({
      queryable: transaction,
      workspaceId: study.workspaceId,
      studyId: study.studyId,
      runId: study.runId,
      subjectKey: `study:${study.publicId}`,
      workflowType: study.workflowType,
    });
    const runTimeoutSeconds = Number(assigned.config.runTimeoutSeconds ?? getRuntimeLimits().runTimeoutSeconds);
    await transaction.query(
      `update study_runs set workflow_type = $2, workflow_version = $3,
              strategy_key = $4, strategy_version = $5, experiment_assignment_id = $6,
              timeout_seconds = $7, reasoning_policy_version = $8
       where id = $1`,
      [
        study.runId, study.workflowType, study.workflowVersion, assigned.variantKey,
        assigned.strategyVersion, assigned.assignmentId, runTimeoutSeconds, REASONING_POLICY_VERSION,
      ],
    );
    return assigned;
  });
  const agentRollout = await resolveResearchAgentRollout({
    queryable: database,
    workspaceId: study.workspaceId,
    strategyKey: strategy.variantKey,
    strategyConfig: strategy.config,
  });
  const agentControllerMode = agentRollout.effectiveMode;
  await database.transaction(async (transaction) => {
    await transaction.query(
      `update study_runs set status = 'running', provider = $2, provider_model = $3,
              started_at = coalesce(started_at, now()), error_message = null
       where id = $1 and status <> 'completed'`,
      [study.runId, provider.provider, provider.model],
    );
    await transaction.query(
      "update studies set status = 'running', current_stage = 'execution', updated_at = now() where id = $1",
      [study.studyId],
    );
  });
  await appendEvent(database, study.studyId, study.runId, resuming ? "run.resumed" : "run.started", {
    provider: provider.provider,
    model: provider.model,
    harness: study.workflowVersion,
    strategy: {
      experimentKey: strategy.experimentKey,
      variantKey: strategy.variantKey,
      strategyVersion: strategy.strategyVersion,
      assignmentId: strategy.assignmentPublicId,
    },
    agentController: {
      mode: agentControllerMode,
      requestedMode: agentRollout.requestedMode,
      rolloutReason: agentRollout.reason,
      rolloutSampleCount: agentRollout.sampleCount,
      version: agentControllerMode === "off" ? null : RESEARCH_AGENT_CONTROLLER_VERSION,
    },
    recoveredTaskKeys: recoveredTasks.map((task) => task.task_key),
  });

  const runController = new AbortController();
  const runTimeoutSeconds = Number(strategy.config.runTimeoutSeconds ?? getRuntimeLimits().runTimeoutSeconds);
  const runTimer = setTimeout(
    () => runController.abort(abortError("RUNTIME_RUN_TIMEOUT")),
    Math.max(30, Math.min(14400, runTimeoutSeconds)) * 1000,
  );
  const cancellationPoll = setInterval(() => {
    void isRunCancellationRequested(study.runId).then((cancelled) => {
      if (cancelled && !runController.signal.aborted) runController.abort(abortError("RUNTIME_CANCELLED"));
    }).catch(() => undefined);
  }, 1_000);

  const state = await loadCheckpoint(runId);
  let context = await retrieveContext({
    workspaceId: study.workspaceId,
    userId: study.createdBy,
    studyId: study.studyId,
    runId: study.runId,
    query: `${study.brief}\n${study.audience}\n${study.framework}`,
    purpose: "research_execution",
    limit: 8,
  });
  await appendEvent(database, study.studyId, study.runId, resuming ? "context.reused" : "context.retrieved", {
    retrievalId: context.retrievalPublicId,
    strategy: context.strategy,
    citationCount: context.citations.length,
    citations: context.citations.map((citation) => ({
      assetPublicId: citation.assetPublicId,
      assetVersionPublicId: citation.assetVersionPublicId,
      chunkPublicId: citation.chunkPublicId,
      title: citation.title,
      score: citation.score,
    })),
  });
  const activeStudy = study;
  async function refreshContextAfterCheckpoint(checkpointDecisionPublicId: string) {
    const refreshed = await database.transaction(async (transaction) => {
      const decision = await evaluateContextRefreshDecision(transaction, {
        workspaceId: activeStudy.workspaceId,
        studyId: activeStudy.studyId,
        runId: activeStudy.runId,
        checkpointDecisionPublicId,
        contextCitationCount: context.citations.length,
        contextRetrievedAt: context.retrievedAt,
        strategyConfig: strategy.config,
      });
      const triggerType = decision.triggerType;
      if (decision.chosenAction !== "refresh_context" || !triggerType) return { decision, snapshot: null };
      const snapshot = await retrieveContextForReasoningDecision(transaction, {
        workspaceId: activeStudy.workspaceId,
        userId: activeStudy.createdBy,
        studyId: activeStudy.studyId,
        runId: activeStudy.runId,
        taskId: decision.targetTaskId,
        reasoningDecisionPublicId: decision.publicId,
        triggerType,
        triggerReason: decision.reason,
        query: [
          activeStudy.brief,
          activeStudy.audience,
          activeStudy.framework,
          decision.targetTaskKey ? `下一任务：${decision.targetTaskKey}` : "",
          triggerType === "conflicted" ? "优先检索可验证冲突或限制条件的受授权 Context。" : "",
        ].filter(Boolean).join("\n"),
        purpose: "research_execution",
        limit: 8,
      });
      return { decision, snapshot };
    });
    const { decision, snapshot } = refreshed;
    const triggerType = decision.triggerType;
    if (!snapshot || !triggerType) return;
    context = snapshot;
    await appendEvent(database, activeStudy.studyId, activeStudy.runId, "context.refreshed", {
      decisionPublicId: decision.publicId,
      triggerType,
      triggerReason: decision.reason,
      targetTaskKey: decision.targetTaskKey,
      retrievalId: context.retrievalPublicId,
      citationCount: context.citations.length,
      citations: context.citations.map((citation) => ({
        assetPublicId: citation.assetPublicId,
        assetVersionPublicId: citation.assetVersionPublicId,
        chunkPublicId: citation.chunkPublicId,
        title: citation.title,
        score: citation.score,
      })),
    });
  }
  const startedAt = Date.now();
  try {
    for (;;) {
      if (runController.signal.aborted || await isRunCancellationRequested(study.runId)) {
        throw runController.signal.reason ?? abortError("RUNTIME_CANCELLED");
      }
      const tasks = await loadTasks(runId);
      for (const task of tasks) {
        if (task.status === "completed" && !(task.key in state)) state[task.key] = task.output;
      }
      const unfinished = tasks.filter((task) => task.status !== "completed" && task.status !== "skipped");
      if (!unfinished.length) {
        await database.transaction((transaction) => evaluateReasoningCheckpoint(transaction, {
          workspaceId: study.workspaceId,
          studyId: study.studyId,
          runId: study.runId,
          strategyConfig: strategy.config,
          tokenBudget: study.estimatedTokens,
          elapsedMs: Date.now() - startedAt,
          triggerType: "terminal",
        }));
        break;
      }
      if (unfinished.some((task) => task.status === "waiting_input")) {
        await recordBatchTaskMetrics(database, strategy.assignmentId, runId);
        return "waiting_input" as const;
      }
      const ready = unfinished.filter((task) => (
        task.status === "pending"
        && (!task.nextAttemptAt || new Date(task.nextAttemptAt).getTime() <= Date.now())
        && task.dependsOn.every((dependency) => dependency in state)
      ));
      if (!ready.length) {
        const terminal = unfinished.find((task) => task.status === "failed");
        if (terminal) throw new TaskTerminalFailure(`任务 ${terminal.key} 未完成`, null);
        const nextAttemptAt = unfinished
          .filter((task) => task.status === "pending" && task.nextAttemptAt)
          .map((task) => new Date(task.nextAttemptAt as string).getTime())
          .filter((time) => Number.isFinite(time))
          .sort((left, right) => left - right)[0];
        if (nextAttemptAt) {
          await waitForRetry(runController.signal, Math.max(50, Math.min(30_000, nextAttemptAt - Date.now())));
          continue;
        }
        const blocked = unfinished.map((task) => `${task.key}<-${task.dependsOn.filter((dependency) => !(dependency in state)).join(",")}`).join(";");
        throw new Error(`HARNESS_DAG_STALLED:${blocked}`);
      }
      const configuredConcurrency = Number(strategy.config.taskConcurrency ?? getRuntimeLimits().taskConcurrency);
      let wave = ready.slice(0, Math.max(1, Math.min(8, configuredConcurrency)));
      if (agentControllerMode !== "off") {
        const controllerInput = {
          study: {
            studyId: study.studyId,
            runId: study.runId,
            publicId: study.publicId,
            userPublicId: study.userPublicId,
            brief: study.brief,
            studyType: study.studyType,
            framework: study.framework,
            methods: study.methods,
            audience: study.audience,
          },
          tasks: tasks.map((task) => ({
            key: task.key,
            title: task.title,
            toolName: task.toolName,
            status: task.status,
            dependsOn: task.dependsOn,
            input: task.input,
            resultSummary: task.status === "completed" ? summarizeResearchAgentTaskResult(task.output) : undefined,
          })),
          completedStateKeys: Object.keys(state),
          contextSummary: context.citations.slice(0, 6).map((citation) => citation.title).join("；"),
          availableToolNames: agentDynamicToolNames,
          allowedTaskTemplates: allowedAgentTaskTemplates(strategy),
          maxDynamicTasks: Math.max(
            0,
            maxAgentDynamicTasks(strategy) - tasks.filter((task) => task.origin === "dynamic").length,
          ),
        };
        try {
          const decision = await decideResearchAgentAction(controllerInput, { queryable: database });
          const validation = validateResearchAgentAction({
            action: decision.action,
            tasks: controllerInput.tasks,
            completedStateKeys: controllerInput.completedStateKeys,
            availableToolNames: controllerInput.availableToolNames,
            allowedTaskTemplates: controllerInput.allowedTaskTemplates,
            maxDynamicTasks: controllerInput.maxDynamicTasks,
          });
          if (agentControllerMode === "active" && validation.accepted) {
            if (decision.action.type === "replan") {
              const applied = await appendResearchAgentDynamicTasks({
                database,
                study,
                tasks,
                action: decision.action,
                strategy,
                decision: {
                  responseId: decision.responseId,
                  model: decision.model,
                  promptVersion: decision.promptVersion,
                },
              });
              if (!applied.accepted) {
                await appendEvent(database, study.studyId, study.runId, "agent.action.rejected", {
                  reason: applied.reason,
                  action: decision.action,
                });
              } else {
                continue;
              }
            } else if (decision.action.type === "ask_user" && validation.task) {
              const inputTask = ready.find((task) => task.key === validation.task?.key);
              if (!inputTask || !["deepResearch", "scoutSocialTrends"].includes(inputTask.toolName)) {
                await appendEvent(database, study.studyId, study.runId, "agent.action.rejected", {
                  reason: "task_input_not_supported",
                  taskKey: validation.task.key,
                  action: decision.action,
                });
              } else {
                await pauseResearchAgentForInput({ database, study, task: inputTask, action: decision.action });
                await recordBatchTaskMetrics(database, strategy.assignmentId, runId);
                return "waiting_input" as const;
              }
            } else if (decision.action.type === "finish") {
              break;
            } else if (validation.task) {
              wave = [ready.find((task) => task.key === validation.task?.key) ?? wave[0]];
            }
          } else if (agentControllerMode === "shadow" && validation.accepted && decision.action.type !== "call_tool") {
            await appendEvent(database, study.studyId, study.runId, "agent.action.shadow_ignored", {
              action: decision.action,
              reason: "shadow_mode",
            });
          }
        } catch (error) {
          await appendEvent(database, study.studyId, study.runId, "agent.controller.failed", {
            controllerVersion: RESEARCH_AGENT_CONTROLLER_VERSION,
            message: error instanceof Error ? error.message.slice(0, 500) : "unknown",
            fallback: "deterministic_dag",
          });
        }
      }
      await appendEvent(database, study.studyId, study.runId, "dag.wave.started", {
        taskKeys: wave.map((task) => task.key),
        concurrency: wave.length,
        controllerMode: agentControllerMode,
      });
      const settled = await Promise.allSettled(wave.map((task) => executeTask({
        study,
        task,
        state: { ...state },
        context,
        strategy,
        runSignal: runController.signal,
      })));
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value.kind === "completed") state[result.value.key] = result.value.output;
      }
      const retryScheduled = settled.filter((result) => result.status === "fulfilled" && result.value.kind === "retry").length;
      const waitingForInput = settled.filter((result) => result.status === "fulfilled" && result.value.kind === "waiting_input").length;
      await appendEvent(database, study.studyId, study.runId, "dag.wave.completed", {
        taskKeys: wave.map((task) => task.key),
        completed: settled.filter((result) => result.status === "fulfilled" && result.value.kind === "completed").length,
        failed: failures.length,
        retryScheduled,
        waitingForInput,
      });
      if (failures.length) throw failures[0].reason;
      if (waitingForInput) {
        await recordBatchTaskMetrics(database, strategy.assignmentId, runId);
        return "waiting_input" as const;
      }
      const remainingTasks = (await loadTasks(runId)).some((task) => task.status !== "completed" && task.status !== "skipped");
      if (remainingTasks) {
        const checkpointDecision = await database.transaction((transaction) => evaluateReasoningCheckpoint(transaction, {
          workspaceId: study.workspaceId,
          studyId: study.studyId,
          runId: study.runId,
          strategyConfig: strategy.config,
          tokenBudget: study.estimatedTokens,
          elapsedMs: Date.now() - startedAt,
          triggerType: resuming ? "resume" : "checkpoint",
        }));
        await refreshContextAfterCheckpoint(checkpointDecision.publicId);
      }
    }
    await materializeStudy(study, state);
    await evaluateResearchAgentTrajectory(database, {
      workspaceId: study.workspaceId,
      studyId: study.studyId,
      runId: study.runId,
      controllerMode: agentControllerMode,
      executionSource: options.executionSource ?? "local_harness_probe",
    });
    const runTokens = Object.values(state).reduce<number>((sum, item) => {
      if (!item || typeof item !== "object" || !("usage" in item)) return sum;
      return sum + totalTokens(item.usage);
    }, 0);
    await recordStrategyMetric(database, strategy.assignmentId, "run_completed", 1);
    await recordStrategyMetric(database, strategy.assignmentId, "run_duration_ms", Date.now() - startedAt);
    await recordStrategyMetric(database, strategy.assignmentId, "run_tokens", runTokens);
    await recordStrategyMetric(database, strategy.assignmentId, "task_count", Object.keys(state).length);
    await recordBatchTaskMetrics(database, strategy.assignmentId, runId);
    return "completed" as const;
  } catch (error) {
    const cancellationRequested = await isRunCancellationRequested(study.runId);
    if (cancellationRequested || (error instanceof DOMException && error.name === "AbortError" && error.message === "RUNTIME_CANCELLED")) {
      await markRunCancelled(study);
      await recordStrategyMetric(database, strategy.assignmentId, "run_cancelled", 1);
      await recordBatchTaskMetrics(database, strategy.assignmentId, runId);
      return "cancelled" as const;
    }
    if (!(error instanceof Error && error.message === "RUNTIME_RATE_LIMITED")) {
      await recordStrategyMetric(database, strategy.assignmentId, "run_failed", 1, {
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
    await recordBatchTaskMetrics(database, strategy.assignmentId, runId);
    throw error;
  } finally {
    clearTimeout(runTimer);
    clearInterval(cancellationPoll);
  }
}

export async function enqueueStudyJob(queryable: Queryable, runId: string) {
  await queryable.query(
    `insert into study_job_queue (run_id, status, available_at)
     values ($1, 'queued', now())
     on conflict (run_id) do update set
       status = case when study_job_queue.status = 'completed' then 'completed' else 'queued' end,
       available_at = now(), lease_owner = null, lease_expires_at = null,
       error_message = null, updated_at = now()`,
    [runId],
  );
}

export async function enqueueLatestStudyRun(publicId: string, workspaceId: string) {
  const database = await getDatabase();
  const result = await database.query<{ run_id: string }>(
    `select run.id::text as run_id
     from studies study
     join lateral (
       select id, status from study_runs
       where study_id = study.id order by created_at desc, id desc limit 1
     ) run on true
     where study.public_id = $1 and study.workspace_id = $2
       and run.status in ('awaiting_provider', 'queued', 'running')
     limit 1`,
    [publicId, workspaceId],
  );
  const runId = result.rows[0]?.run_id;
  if (!runId) return null;
  await enqueueStudyJob(database, runId);
  return runId;
}

async function claimStudyJob(workerId: string) {
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      id: string; run_id: string; attempt: number; max_attempts: number;
      workspace_id: string; provider_name: string;
    }>(
      `select job.id::text as id, job.run_id::text as run_id, job.attempt, job.max_attempts,
              study.workspace_id::text as workspace_id,
              coalesce(run.provider, $1) as provider_name
       from study_job_queue job
       join study_runs run on run.id = job.run_id
       join studies study on study.id = run.study_id
       where job.available_at <= now()
         and (job.status = 'queued' or (job.status = 'leased' and job.lease_expires_at < now()))
         and run.status <> 'waiting_input'
       order by job.available_at, job.id
       for update skip locked
       limit 1`,
      [getRunProviderSummary().provider],
    );
    const job = result.rows[0];
    if (!job) return null;
    await transaction.query(
      `update study_job_queue set status = 'leased', lease_owner = $2,
              lease_expires_at = now() + interval '10 minutes', attempt = attempt + 1,
              updated_at = now()
       where id = $1`,
      [job.id, workerId],
    );
    return { ...job, attempt: job.attempt + 1 };
  });
}

async function deferStudyJob(jobId: string, workerId: string, reason: string, delaySeconds = 3) {
  const database = await getDatabase();
  await database.query(
    `update study_job_queue set status = 'queued', available_at = now() + ($3 * interval '1 second'),
            attempt = greatest(0, attempt - 1), lease_owner = null, lease_expires_at = null,
            error_message = $4, updated_at = now()
     where id = $1 and status = 'leased' and lease_owner = $2`,
    [jobId, workerId, delaySeconds, reason],
  );
}

async function finishStudyJob(jobId: string, workerId: string) {
  const database = await getDatabase();
  await database.query(
    `update study_job_queue set status = 'completed', lease_owner = null,
            lease_expires_at = null, error_message = null, updated_at = now()
     where id = $1 and status = 'leased' and lease_owner = $2`,
    [jobId, workerId],
  );
}

async function pauseStudyJob(jobId: string, workerId: string) {
  const database = await getDatabase();
  await database.query(
    `update study_job_queue set status = 'waiting_input', lease_owner = null,
            lease_expires_at = null, updated_at = now()
     where id = $1 and status = 'leased' and lease_owner = $2`,
    [jobId, workerId],
  );
}

async function handleStudyJobFailure(job: {
  id: string;
  run_id: string;
  attempt: number;
  max_attempts: number;
}, workerId: string, error: unknown) {
  const database = await getDatabase();
  const classified = classifyTaskError(error);
  const described = describeOpenAIError(error);
  const retry = classified.disposition === "retry" && job.attempt < job.max_attempts;
  await database.transaction(async (transaction) => {
    const released = await transaction.query<{ id: string }>(
      `update study_job_queue set status = $2,
              available_at = case when $2 = 'queued' then now() + ($3 * interval '1 second') else available_at end,
              lease_owner = null, lease_expires_at = null, error_message = $4, updated_at = now()
       where id = $1 and status = 'leased' and lease_owner = $5
       returning id::text as id`,
      [job.id, retry ? "queued" : "failed", Math.min(30, 2 ** job.attempt), described.message, workerId],
    );
    if (!released.rows[0]) return;
    const run = await transaction.query<{ study_id: string }>(
      "select study_id::text as study_id from study_runs where id = $1",
      [job.run_id],
    );
    const studyId = run.rows[0]?.study_id;
    if (!studyId) return;
    await transaction.query(
      `update study_runs set status = $2, error_message = $3,
              finished_at = case when $2 = 'failed' then now() else null end
       where id = $1`,
      [job.run_id, retry ? "queued" : "failed", described.message],
    );
    await transaction.query(
      `update studies set status = $2, updated_at = now() where id = $1`,
      [studyId, retry ? "queued" : "failed"],
    );
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, $3, $4::jsonb)`,
      [
        studyId,
        job.run_id,
        retry ? "run.retry_scheduled" : "run.failed",
        JSON.stringify({ message: described.message, attempt: job.attempt, retry }),
      ],
    );
  });
}

export async function processStudyJobQueue(options: {
  workerId?: string;
  maxJobs?: number;
} = {}) {
  const workerId = options.workerId ?? `research-${randomUUID()}`;
  const maxJobs = options.maxJobs ?? 1;
  const jobs: Array<NonNullable<Awaited<ReturnType<typeof claimStudyJob>>>> = [];
  let claims = 0;
  while (jobs.length < maxJobs && claims < maxJobs * 3) {
    claims += 1;
    const job = await claimStudyJob(workerId);
    if (!job) break;
    const slot = await acquireProviderRuntimeSlot({
      runId: job.run_id,
      workspaceId: job.workspace_id,
      providerName: job.provider_name,
      workerId,
    });
    if (!slot.acquired) {
      await deferStudyJob(job.id, workerId, slot.reason, 3);
      continue;
    }
    jobs.push(job);
  }
  await Promise.all(jobs.map(async (job) => {
    const database = await getDatabase();
    const heartbeat = setInterval(() => {
      void database.query(
        `update study_job_queue set lease_expires_at = now() + interval '10 minutes', updated_at = now()
         where id = $1 and status = 'leased' and lease_owner = $2`,
        [job.id, workerId],
      ).then(() => renewProviderRuntimeSlot(job.run_id, workerId)).catch(() => undefined);
    }, 60_000);
    try {
      const result = await runStudyHarness(job.run_id, { executionSource: "worker" });
      if (result === "cancelled") {
        await database.query(
          `update study_job_queue set status = 'cancelled', lease_owner = null,
                  lease_expires_at = null, updated_at = now()
           where id = $1 and lease_owner = $2`,
          [job.id, workerId],
        );
      } else if (result === "waiting_input") {
        await pauseStudyJob(job.id, workerId);
      } else {
        await finishStudyJob(job.id, workerId);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "RUNTIME_RATE_LIMITED") {
        await deferStudyJob(job.id, workerId, error.message, 5);
      } else {
        await handleStudyJobFailure(job, workerId, error);
      }
    } finally {
      clearInterval(heartbeat);
      await releaseProviderRuntimeSlot(job.run_id, workerId);
    }
  }));
  return jobs.length;
}

export async function cancelStudyRun(viewer: Viewer, publicId: string) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      study_id: string; run_id: string | null; run_status: string | null; job_status: string | null;
    }>(
      `select study.id::text as study_id, run.id::text as run_id, run.status as run_status,
              job.status as job_status
       from studies study
       left join lateral (
         select id, status from study_runs where study_id = study.id order by created_at desc, id desc limit 1
       ) run on true
       left join study_job_queue job on job.run_id = run.id
       where study.public_id = $1 and study.workspace_id = $2
       for update of study`,
      [publicId, viewer.workspaceId],
    );
    const study = result.rows[0];
    if (!study) return "not_found" as const;
    if (!study.run_id || !study.run_status) return "not_running" as const;
    if (["completed", "failed", "cancelled"].includes(study.run_status)) return "not_running" as const;
    const immediate = study.run_status !== "running" && study.job_status !== "leased";
    await transaction.query(
      `update study_runs set cancel_requested_at = coalesce(cancel_requested_at, now()),
              status = case when $2 then 'cancelled' else status end,
              cancelled_at = case when $2 then coalesce(cancelled_at, now()) else cancelled_at end,
              finished_at = case when $2 then coalesce(finished_at, now()) else finished_at end
       where id = $1`,
      [study.run_id, immediate],
    );
    if (immediate) {
      await transaction.query(
        `update study_job_queue set status = 'cancelled', lease_owner = null, lease_expires_at = null, updated_at = now()
         where run_id = $1 and status in ('queued', 'leased')`,
        [study.run_id],
      );
      await transaction.query(
        `update study_tasks set status = 'skipped', error_message = 'RUNTIME_CANCELLED',
                finished_at = coalesce(finished_at, now()), updated_at = now()
         where run_id = $1 and status in ('pending', 'waiting_input')`,
        [study.run_id],
      );
      await transaction.query("update studies set status = 'cancelled', updated_at = now() where id = $1", [study.study_id]);
    }
    await transaction.query(
      `insert into study_events (study_id, run_id, event_type, payload)
       values ($1, $2, $3, $4::jsonb)`,
      [
        study.study_id, study.run_id, immediate ? "run.cancelled" : "run.cancel.requested",
        JSON.stringify({ requestedBy: viewer.userPublicId }),
      ],
    );
    return immediate ? "cancelled" as const : "requested" as const;
  });
}
