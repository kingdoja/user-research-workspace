import { createHash } from "node:crypto";
import type { Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { ContextSnapshot } from "@/lib/context-system";
import type { StudyMethod, StudyProductLine, WorkflowType } from "@/lib/research-types";
import { classifyResearchQuestionTypes } from "@/lib/research-report-design";

type ClarificationQuestionLike = { id: string };
type ClarificationAnswerLike = { questionId: string; selected: string[] };

export type IntentPlanInput = {
  studyType: string;
  methods: StudyMethod[];
  personaFilters: { audience: string; source: string };
  personaCount: number;
  estimatedDurationMinutes: number;
  estimatedTokens: number;
  source: "local_rules" | "openai";
  responseId: string | null;
  model: string | null;
  promptVersion: string;
};

export type LockedIntentVersion = {
  id: string;
  publicId: string;
  version: number;
  schemaVersion: string;
  lifecycleStatus: "draft" | "confirmed";
  contentHash: string;
  contextRetrievalId: string | null;
};

export type LockedWorkflowDefinition = {
  id: string;
  publicId: string;
  version: number;
  schemaVersion: string;
  workflowType: Exclude<WorkflowType, "realtime_agent">;
  templateVersion: string;
  contentHash: string;
};

function hashContract(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function selectedAnswer(answers: ClarificationAnswerLike[], questionId: string) {
  return answers.find((answer) => answer.questionId === questionId)?.selected ?? [];
}

function intentContent(input: {
  brief: string;
  productLine: StudyProductLine;
  plan: IntentPlanInput;
  questions: ClarificationQuestionLike[];
  answers: ClarificationAnswerLike[];
  context: ContextSnapshot;
}) {
  const audienceAnswers = selectedAnswer(input.answers, "target_audience");
  const scopeAnswers = selectedAnswer(input.answers, "research_scope");
  const businessGoals = selectedAnswer(input.answers, "business_goal");
  const researchFocus = selectedAnswer(input.answers, "research_focus");
  const marketInsight = input.productLine === "market_insight";
  const publicOnly = marketInsight || scopeAnswers.some((value) => value.includes("仅使用公开资料"));
  const questionTypes = classifyResearchQuestionTypes(input.brief);
  const publicEvidenceBoundary = publicOnly && questionTypes.some((type) => type === "behavioral" || type === "attitudinal" || type === "causal");
  const contextReferences = input.context.citations.map((citation) => ({
    assetPublicId: citation.assetPublicId,
    assetVersionPublicId: citation.assetVersionPublicId,
    chunkPublicId: citation.chunkPublicId,
    assetType: citation.assetType,
    title: citation.title,
    memoryKind: citation.memoryKind,
  }));

  return {
    schemaVersion: "research-intent-v1",
    productLine: input.productLine,
    objective: input.brief,
    audience: {
      description: audienceAnswers.join("、") || input.plan.personaFilters.audience,
      filters: {},
    },
    studyType: input.plan.studyType,
    budget: {
      maxTokens: input.plan.estimatedTokens,
      maxDurationMinutes: input.plan.estimatedDurationMinutes,
      maxParticipantsOrPersonas: input.plan.personaCount,
      humanConfirmationRequired: true,
    },
    dataScope: {
      allowedScopes: ["user", "workspace", "study"],
      allowedAssetTypes: publicOnly
        ? ["core_memory", "team_memory", "study_context"]
        : ["core_memory", "team_memory", "research_sample", "persona", "study_context"],
      evidenceMode: publicOnly ? "public_sources_only" : "public_and_governed_synthetic",
      contextReferences,
    },
    compliance: {
      consentRequiredForHumanData: true,
      piiPolicy: "redacted_or_reviewed",
      evidenceRequired: true,
      distinguishHumanSyntheticAndInference: true,
    },
    allowedContextPurposes: ["intent_planning"],
    requestedMethods: input.plan.methods,
    exclusions: publicOnly
      ? ["synthetic_persona_interview", "unverified_human_quote", "private_unapproved_context"]
      : ["unverified_human_quote", "private_unapproved_context"],
    assumptions: [
      ...businessGoals.map((value) => `业务目标：${value}`),
      ...researchFocus.map((value) => `研究重点：${value}`),
      ...scopeAnswers.map((value) => `证据范围：${value}`),
      ...(publicEvidenceBoundary ? ["公开资料只能形成方向性分析；行为、态度或因果结论仍需直接证据验证。"] : []),
    ],
    openQuestions: [
      ...input.questions
        .filter((question) => !input.answers.some((answer) => answer.questionId === question.id))
        .map((question) => question.id),
      ...(publicEvidenceBoundary ? ["需要确认是否接受方向性分析，或补充平台行为、真人研究或实验数据。"] : []),
    ],
    sourceBrief: input.brief,
    clarificationAnswers: input.answers,
    parserSource: input.plan.source,
    providerResponseId: input.plan.responseId,
    providerModel: input.plan.model,
    promptVersion: input.plan.promptVersion,
  };
}

export function formatIntentPlanningContext(context: ContextSnapshot) {
  if (!context.citations.length) return "";
  return context.citations.slice(0, 8).map((citation, index) => (
    `[Intent Context ${index + 1} | ${citation.assetVersionPublicId} | ${citation.assetType}] ${citation.title}\n${citation.content.slice(0, 1200)}`
  )).join("\n\n");
}

export async function createDraftIntentVersion(
  queryable: Queryable,
  input: {
    workspaceId: string;
    studyId: string;
    brief: string;
    productLine: StudyProductLine;
    plan: IntentPlanInput;
    questions: ClarificationQuestionLike[];
    answers: ClarificationAnswerLike[];
    context: ContextSnapshot;
    snapshotReason: "brief_creation" | "clarification";
  },
): Promise<LockedIntentVersion> {
  const content = intentContent(input);
  const previous = await queryable.query<{ id: string }>(
    `select id::text as id from study_intent_versions
     where study_id = $1 order by version desc limit 1`,
    [input.studyId],
  );
  const result = await queryable.query<{
    id: string; public_id: string; version: number; schema_version: string;
    lifecycle_status: "draft"; content_hash: string; context_retrieval_id: string | null;
  }>(
    `insert into study_intent_versions (
       public_id, workspace_id, study_id, version, lifecycle_status, snapshot_reason,
       supersedes_intent_version_id, product_line, objective, audience, study_type, budget, data_scope,
       compliance, allowed_context_purposes, requested_methods, exclusions, assumptions,
       open_questions, source_brief, clarification_answers, context_retrieval_id,
       parser_source, provider_response_id, provider_model, prompt_version, content_hash
     ) values (
       $1, $2, $3,
       (select coalesce(max(version), 0) + 1 from study_intent_versions where study_id = $3),
       'draft', $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb,
       $13::text[], $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19::jsonb,
       $20, $21, $22, $23, $24, $25
     ) returning id::text as id, public_id, version, schema_version, lifecycle_status,
                 content_hash, context_retrieval_id::text as context_retrieval_id`,
    [
      createPublicId("itv"), input.workspaceId, input.studyId, input.snapshotReason,
      previous.rows[0]?.id ?? null, content.productLine, content.objective, JSON.stringify(content.audience),
      content.studyType, JSON.stringify(content.budget), JSON.stringify(content.dataScope),
      JSON.stringify(content.compliance), content.allowedContextPurposes,
      JSON.stringify(content.requestedMethods), JSON.stringify(content.exclusions),
      JSON.stringify(content.assumptions), JSON.stringify(content.openQuestions),
      content.sourceBrief, JSON.stringify(content.clarificationAnswers),
      input.context.retrievalId, content.parserSource, content.providerResponseId,
      content.providerModel, content.promptVersion, hashContract(content),
    ],
  );
  const version = result.rows[0];
  await queryable.query("update studies set current_intent_version_id = $2 where id = $1", [input.studyId, version.id]);
  return {
    id: version.id,
    publicId: version.public_id,
    version: version.version,
    schemaVersion: version.schema_version,
    lifecycleStatus: version.lifecycle_status,
    contentHash: version.content_hash,
    contextRetrievalId: version.context_retrieval_id,
  };
}

export async function createConfirmedIntentVersion(
  queryable: Queryable,
  studyId: string,
  confirmedBy: string,
): Promise<LockedIntentVersion> {
  const current = await queryable.query<{
    id: string; workspace_id: string; product_line: StudyProductLine; objective: string; audience: unknown; study_type: string;
    budget: unknown; data_scope: unknown; compliance: unknown; allowed_context_purposes: string[] | string;
    requested_methods: unknown; exclusions: unknown; assumptions: unknown; open_questions: unknown;
    source_brief: string; clarification_answers: unknown; context_retrieval_id: string | null;
    parser_source: string; provider_response_id: string | null; provider_model: string | null;
    prompt_version: string; content_hash: string;
  }>(
    `select intent.id::text as id, intent.workspace_id::text as workspace_id, intent.product_line, intent.objective,
            intent.audience, intent.study_type, intent.budget, intent.data_scope, intent.compliance,
            intent.allowed_context_purposes, intent.requested_methods, intent.exclusions,
            intent.assumptions, intent.open_questions, intent.source_brief,
            intent.clarification_answers, intent.context_retrieval_id::text as context_retrieval_id,
            intent.parser_source, intent.provider_response_id, intent.provider_model,
            intent.prompt_version, intent.content_hash
     from studies study join study_intent_versions intent on intent.id = study.current_intent_version_id
     where study.id = $1 limit 1`,
    [studyId],
  );
  let source = current.rows[0];
  if (!source) {
    const legacy = await queryable.query<{
      workspace_id: string; product_line: StudyProductLine; brief: string; study_type: string; methods: unknown;
      persona_filters: unknown; persona_count: number; estimated_duration_minutes: number;
      estimated_tokens: string; source: string; provider_response_id: string | null;
      provider_model: string | null; prompt_version: string;
    }>(
      `select study.workspace_id::text as workspace_id, study.product_line, study.brief, study.study_type,
              plan.methods, plan.persona_filters, plan.persona_count,
              plan.estimated_duration_minutes, plan.estimated_tokens::text as estimated_tokens,
              plan.source, plan.provider_response_id, plan.provider_model, plan.prompt_version
       from studies study join study_plans plan on plan.study_id = study.id where study.id = $1`,
      [studyId],
    );
    const row = legacy.rows[0];
    if (!row) throw new Error("INTENT_SOURCE_MISSING");
    const legacyContent = {
      schemaVersion: "research-intent-v1", objective: row.brief,
      productLine: row.product_line,
      audience: typeof row.persona_filters === "string" ? JSON.parse(row.persona_filters) : row.persona_filters,
      studyType: row.study_type,
      budget: { maxTokens: Number(row.estimated_tokens), maxDurationMinutes: row.estimated_duration_minutes, maxParticipantsOrPersonas: row.persona_count, humanConfirmationRequired: true },
      dataScope: { recoveryMode: "legacy_backfill", contextReferences: [] },
      compliance: { evidenceRequired: true, recoveryMode: "legacy_backfill" },
      allowedContextPurposes: ["intent_planning"],
      requestedMethods: typeof row.methods === "string" ? JSON.parse(row.methods) : row.methods,
      exclusions: [], assumptions: ["历史创建流程未保存完整 Intent；仅保留可确认字段。"], openQuestions: [],
      sourceBrief: row.brief, clarificationAnswers: [], parserSource: row.source,
      providerResponseId: row.provider_response_id, providerModel: row.provider_model,
      promptVersion: row.prompt_version,
    };
    source = {
      id: "", workspace_id: row.workspace_id, product_line: row.product_line, objective: row.brief, audience: legacyContent.audience,
      study_type: row.study_type, budget: legacyContent.budget, data_scope: legacyContent.dataScope,
      compliance: legacyContent.compliance, allowed_context_purposes: ["intent_planning"],
      requested_methods: legacyContent.requestedMethods, exclusions: [], assumptions: legacyContent.assumptions,
      open_questions: [], source_brief: row.brief, clarification_answers: [], context_retrieval_id: null,
      parser_source: row.source, provider_response_id: row.provider_response_id,
      provider_model: row.provider_model, prompt_version: row.prompt_version,
      content_hash: hashContract(legacyContent),
    };
  }
  const result = await queryable.query<{
    id: string; public_id: string; version: number; schema_version: string;
    lifecycle_status: "confirmed"; content_hash: string; context_retrieval_id: string | null;
  }>(
    `insert into study_intent_versions (
       public_id, workspace_id, study_id, version, lifecycle_status, snapshot_reason,
       supersedes_intent_version_id, product_line, objective, audience, study_type, budget, data_scope,
       compliance, allowed_context_purposes, requested_methods, exclusions, assumptions,
       open_questions, source_brief, clarification_answers, context_retrieval_id,
       parser_source, provider_response_id, provider_model, prompt_version, content_hash,
       confirmed_by, confirmed_at
     ) values (
       $1, $2, $3, (select coalesce(max(version), 0) + 1 from study_intent_versions where study_id = $3),
       'confirmed', $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb,
       $13::text[], $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19::jsonb,
       $20, $21, $22, $23, $24, $25, $26, now()
     ) returning id::text as id, public_id, version, schema_version, lifecycle_status,
                 content_hash, context_retrieval_id::text as context_retrieval_id`,
    [
      createPublicId("itv"), source.workspace_id, studyId, source.id ? "confirmation" : "legacy_backfill",
      source.id || null, source.product_line, source.objective, JSON.stringify(source.audience), source.study_type,
      JSON.stringify(source.budget), JSON.stringify(source.data_scope), JSON.stringify(source.compliance),
      typeof source.allowed_context_purposes === "string" ? JSON.parse(source.allowed_context_purposes) : source.allowed_context_purposes,
      JSON.stringify(source.requested_methods), JSON.stringify(source.exclusions), JSON.stringify(source.assumptions),
      JSON.stringify(source.open_questions), source.source_brief, JSON.stringify(source.clarification_answers),
      source.context_retrieval_id, source.parser_source, source.provider_response_id,
      source.provider_model, source.prompt_version, source.content_hash, confirmedBy,
    ],
  );
  const version = result.rows[0];
  await queryable.query("update studies set current_intent_version_id = $2 where id = $1", [studyId, version.id]);
  return {
    id: version.id, publicId: version.public_id, version: version.version,
    schemaVersion: version.schema_version, lifecycleStatus: version.lifecycle_status,
    contentHash: version.content_hash, contextRetrievalId: version.context_retrieval_id,
  };
}

export async function compileWorkflowDefinition(queryable: Queryable, input: {
  workspaceId: string;
  studyId: string;
  intentVersionId: string;
  planVersionId: string;
  taskGraph: unknown[];
  skillRequirements: Array<{ slug: string; version: number }>;
  runtimeLimits: { runTimeoutSeconds: number; taskTimeoutSeconds: number };
  workflowType: Exclude<WorkflowType, "realtime_agent">;
  templateKey: string;
  templateVersion: string;
  outputContracts: string[];
  compiledBy: string;
}): Promise<LockedWorkflowDefinition> {
  const content = {
    schemaVersion: "workflow-definition-v1",
    workflowType: input.workflowType,
    templateKey: input.templateKey,
    templateVersion: input.templateVersion,
    taskGraph: input.taskGraph,
    runtimeLimits: input.runtimeLimits,
    skillRequirements: input.skillRequirements,
    contextPolicy: { purpose: "research_execution", inheritIntentRetrieval: false, policyVersion: "memory-policy-v1" },
    outputContracts: input.outputContracts,
    evidenceGates: { distinguishHumanSyntheticAndInference: true, citationsRequiredForFacts: true },
    compilerVersion: "intent-workflow-compiler-v1",
  };
  const result = await queryable.query<{
    id: string; public_id: string; version: number; schema_version: string;
    workflow_type: Exclude<WorkflowType, "realtime_agent">; template_version: string; content_hash: string;
  }>(
    `insert into workflow_definitions (
       public_id, workspace_id, study_id, version, workflow_type, template_key,
       template_version, intent_version_id, plan_version_id, task_graph, runtime_limits,
       skill_requirements, context_policy, output_contracts, evidence_gates,
       compiler_version, content_hash, compiled_by
     ) values (
       $1, $2, $3, (select coalesce(max(version), 0) + 1 from workflow_definitions where study_id = $3),
       $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
       $13::jsonb, $14::jsonb, $15, $16, $17
     ) returning id::text as id, public_id, version, schema_version, workflow_type,
                 template_version, content_hash`,
    [
      createPublicId("wfd"), input.workspaceId, input.studyId, content.workflowType,
      content.templateKey, content.templateVersion, input.intentVersionId, input.planVersionId,
      JSON.stringify(content.taskGraph), JSON.stringify(content.runtimeLimits),
      JSON.stringify(content.skillRequirements), JSON.stringify(content.contextPolicy),
      JSON.stringify(content.outputContracts), JSON.stringify(content.evidenceGates),
      content.compilerVersion, hashContract(content), input.compiledBy,
    ],
  );
  const workflow = result.rows[0];
  return {
    id: workflow.id, publicId: workflow.public_id, version: workflow.version,
    schemaVersion: workflow.schema_version, workflowType: workflow.workflow_type,
    templateVersion: workflow.template_version, contentHash: workflow.content_hash,
  };
}
