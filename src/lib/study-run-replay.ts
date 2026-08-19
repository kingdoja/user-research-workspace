import type { Viewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import type { StudyProductLine } from "@/lib/research-types";

type JsonObject = Record<string, unknown>;

export type StudyRunReplayOption = {
  publicId: string;
  attempt: number;
  status: string;
  planVersion: number;
  planVersionPublicId: string;
  createdAt: string;
};

export type StudyRunReplaySnapshot = StudyRunReplayOption & {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  provider: string | null;
  model: string | null;
  usage: JsonObject;
  totalTokens: number;
  error: string | null;
  plan: {
    productLine: StudyProductLine;
    schemaVersion: string;
    contentHash: string;
    snapshotReason: string;
    brief: string;
    studyType: string;
    framework: string;
    methods: string[];
    personaFilters: JsonObject;
    personaCount: number;
    estimatedDurationMinutes: number;
    estimatedTokens: number;
    source: string;
    providerModel: string | null;
    promptVersion: string;
    rationale: string;
    confirmedAt: string | null;
  };
  intent: {
    publicId: string;
    version: number;
    schemaVersion: string;
    contentHash: string;
    lifecycleStatus: string;
    objective: string;
    contextRetrievalPublicId: string | null;
    contextCitationCount: number;
  } | null;
  workflowDefinition: {
    publicId: string;
    version: number;
    schemaVersion: string;
    contentHash: string;
    templateVersion: string;
    compilerVersion: string;
    taskCount: number;
    skillRequirements: Array<{ slug: string; version: number }>;
  } | null;
  versions: {
    workflowType: string;
    workflowVersion: string;
    strategyKey: string;
    strategyVersion: string;
    reasoningPolicyVersion: string;
    promptVersion: string | null;
  };
  counts: {
    tasks: number;
    completedTasks: number;
    failedTasks: number;
    dynamicTasks: number;
    taskRetries: number;
    decisions: number;
    artifacts: number;
    events: number;
    invocations: number;
    failedInvocations: number;
  };
  checkpoint: {
    cursor: number;
    stateHash: string | null;
  };
  context: {
    publicId: string;
    strategy: string;
    embeddingModel: string | null;
    embeddingVersion: string | null;
    lexicalWeight: number | null;
    semanticWeight: number | null;
    itemCount: number;
    purpose: string;
    policyVersion: string;
    policyDecision: JsonObject;
  } | null;
  skills: Array<{ slug: string; version: number }>;
  tasks: Array<{
    key: string;
    title: string;
    toolName: string;
    status: string;
    origin: string;
    generation: number;
    attempt: number;
    outputHash: string;
  }>;
  decisions: Array<{
    sequence: number;
    policyVersion: string;
    action: string;
    reason: string;
    createdAt: string;
  }>;
  artifacts: Array<{
    publicId: string;
    type: string;
    title: string;
    contentHash: string;
    createdAt: string;
  }>;
  timeline: Array<{
    id: string;
    type: string;
    createdAt: string;
  }>;
  trajectoryEvaluation: {
    publicId: string;
    evaluatorVersion: string;
    controllerMode: "off" | "shadow" | "active";
    metrics: JsonObject;
    createdAt: string;
  } | null;
};

export type StudyRunComparison = {
  study: { publicId: string; title: string };
  options: StudyRunReplayOption[];
  left: StudyRunReplaySnapshot | null;
  right: StudyRunReplaySnapshot | null;
  differences: string[];
};

type RunRow = {
  id: string;
  public_id: string;
  attempt: number;
  status: string;
  provider: string | null;
  provider_model: string | null;
  prompt_version: string | null;
  usage: JsonObject | string;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  workflow_type: string;
  workflow_version: string;
  strategy_key: string;
  strategy_version: string;
  reasoning_policy_version: string;
  plan_version: number;
  plan_public_id: string;
  plan_schema_version: string;
  plan_content_hash: string;
  plan_snapshot_reason: string;
  brief_snapshot: string;
  product_line: StudyProductLine;
  study_type: string;
  framework: string;
  methods: string[] | string;
  persona_filters: JsonObject | string;
  persona_count: number;
  estimated_duration_minutes: number;
  estimated_tokens: string;
  plan_source: string;
  plan_provider_model: string | null;
  plan_prompt_version: string;
  rationale: string;
  confirmed_at: string | null;
  intent_public_id: string | null;
  intent_version: number | null;
  intent_schema_version: string | null;
  intent_content_hash: string | null;
  intent_lifecycle_status: string | null;
  intent_objective: string | null;
  intent_context_public_id: string | null;
  intent_context_item_count: number;
  workflow_definition_public_id: string | null;
  workflow_definition_version: number | null;
  workflow_definition_schema_version: string | null;
  workflow_definition_content_hash: string | null;
  workflow_definition_template_version: string | null;
  workflow_definition_compiler_version: string | null;
  workflow_definition_task_count: number;
  workflow_definition_skills: Array<{ slug: string; version: number }> | string | null;
  task_count: number;
  completed_task_count: number;
  failed_task_count: number;
  dynamic_task_count: number;
  task_retry_count: number;
  decision_count: number;
  artifact_count: number;
  event_count: number;
  invocation_count: number;
  failed_invocation_count: number;
  checkpoint_cursor: number;
  checkpoint_state_hash: string | null;
  context_public_id: string | null;
  context_strategy: string | null;
  context_embedding_model: string | null;
  context_embedding_version: string | null;
  context_lexical_weight: number | null;
  context_semantic_weight: number | null;
  context_item_count: number;
  context_purpose: string | null;
  context_policy_version: string | null;
  context_policy_decision: JsonObject | string | null;
};

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function totalTokens(usage: JsonObject) {
  for (const key of ["total_tokens", "totalTokens"]) {
    if (typeof usage[key] === "number") return usage[key];
  }
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return input + output;
}

function optionFromRun(run: RunRow): StudyRunReplayOption {
  return {
    publicId: run.public_id,
    attempt: run.attempt,
    status: run.status,
    planVersion: run.plan_version,
    planVersionPublicId: run.plan_public_id,
    createdAt: run.created_at,
  };
}

function compareSnapshots(left: StudyRunReplaySnapshot | null, right: StudyRunReplaySnapshot | null) {
  if (!left || !right) return [];
  const differences: string[] = [];
  if (left.plan.contentHash !== right.plan.contentHash) differences.push("研究计划");
  if (left.plan.productLine !== right.plan.productLine) differences.push("产品线");
  if (left.intent?.contentHash !== right.intent?.contentHash) differences.push("研究意图");
  if (left.workflowDefinition?.contentHash !== right.workflowDefinition?.contentHash) differences.push("Workflow Definition");
  if (left.versions.workflowVersion !== right.versions.workflowVersion) differences.push("Workflow 版本");
  if (`${left.versions.strategyKey}:${left.versions.strategyVersion}` !== `${right.versions.strategyKey}:${right.versions.strategyVersion}`) differences.push("策略版本");
  if (left.versions.reasoningPolicyVersion !== right.versions.reasoningPolicyVersion) differences.push("Reasoning Policy");
  if (`${left.provider}:${left.model}` !== `${right.provider}:${right.model}`) differences.push("Provider 模型");
  if (left.versions.promptVersion !== right.versions.promptVersion) differences.push("Prompt 版本");
  if (`${left.context?.strategy}:${left.context?.embeddingModel}:${left.context?.embeddingVersion}:${left.context?.purpose}:${left.context?.policyVersion}` !== `${right.context?.strategy}:${right.context?.embeddingModel}:${right.context?.embeddingVersion}:${right.context?.purpose}:${right.context?.policyVersion}`) differences.push("Context 检索");
  const leftSkills = left.skills.map((skill) => `${skill.slug}@${skill.version}`).sort().join(",");
  const rightSkills = right.skills.map((skill) => `${skill.slug}@${skill.version}`).sort().join(",");
  if (leftSkills !== rightSkills) differences.push("Skill 版本");
  const leftTasks = left.tasks.map((task) => `${task.key}:${task.toolName}:${task.origin}:${task.generation}`).join("|");
  const rightTasks = right.tasks.map((task) => `${task.key}:${task.toolName}:${task.origin}:${task.generation}`).join("|");
  if (leftTasks !== rightTasks) differences.push("任务图");
  if (left.status !== right.status || left.totalTokens !== right.totalTokens || left.counts.artifacts !== right.counts.artifacts) differences.push("运行结果");
  return differences;
}

export async function getStudyRunComparison(
  viewer: Viewer,
  studyPublicId: string,
  requestedLeft?: string | null,
  requestedRight?: string | null,
): Promise<StudyRunComparison | null> {
  const database = await getDatabase();
  const studyResult = await database.query<{ id: string; public_id: string; title: string }>(
    `select id::text as id, public_id, title
     from studies where public_id = $1 and workspace_id = $2 limit 1`,
    [studyPublicId, viewer.workspaceId],
  );
  const study = studyResult.rows[0];
  if (!study) return null;

  const runsResult = await database.query<RunRow>(
    `select run.id::text as id, run.public_id,
            row_number() over (order by run.created_at, run.id)::int as attempt,
            run.status, run.provider, run.provider_model, run.prompt_version, run.usage,
            run.error_message, run.started_at::text as started_at,
            run.finished_at::text as finished_at, run.created_at::text as created_at,
            run.workflow_type, run.workflow_version, run.strategy_key, run.strategy_version,
            run.reasoning_policy_version,
            plan.version as plan_version, plan.public_id as plan_public_id,
            plan.schema_version as plan_schema_version, plan.content_hash as plan_content_hash,
            plan.snapshot_reason as plan_snapshot_reason, plan.product_line, plan.brief_snapshot, plan.study_type,
            plan.framework, plan.methods, plan.persona_filters, plan.persona_count,
            plan.estimated_duration_minutes, plan.estimated_tokens::text as estimated_tokens,
            plan.source as plan_source, plan.provider_model as plan_provider_model,
            plan.prompt_version as plan_prompt_version, plan.rationale,
            plan.confirmed_at::text as confirmed_at,
            intent.public_id as intent_public_id, intent.version as intent_version,
            intent.schema_version as intent_schema_version, intent.content_hash as intent_content_hash,
            intent.lifecycle_status as intent_lifecycle_status, intent.objective as intent_objective,
            intent_context.public_id as intent_context_public_id,
            coalesce((select count(*) from context_retrieval_items item where item.retrieval_id = intent_context.id), 0)::int as intent_context_item_count,
            workflow.public_id as workflow_definition_public_id,
            workflow.version as workflow_definition_version,
            workflow.schema_version as workflow_definition_schema_version,
            workflow.content_hash as workflow_definition_content_hash,
            workflow.template_version as workflow_definition_template_version,
            workflow.compiler_version as workflow_definition_compiler_version,
            coalesce(jsonb_array_length(workflow.task_graph), 0)::int as workflow_definition_task_count,
            workflow.skill_requirements as workflow_definition_skills,
            coalesce(task_stats.task_count, 0)::int as task_count,
            coalesce(task_stats.completed_count, 0)::int as completed_task_count,
            coalesce(task_stats.failed_count, 0)::int as failed_task_count,
            coalesce(task_stats.dynamic_count, 0)::int as dynamic_task_count,
            coalesce(task_stats.retry_count, 0)::int as task_retry_count,
            coalesce(decision_stats.decision_count, 0)::int as decision_count,
            coalesce(artifact_stats.artifact_count, 0)::int as artifact_count,
            coalesce(event_stats.event_count, 0)::int as event_count,
            coalesce(invocation_stats.invocation_count, 0)::int as invocation_count,
            coalesce(invocation_stats.failed_count, 0)::int as failed_invocation_count,
            coalesce(checkpoint.cursor, 0)::int as checkpoint_cursor,
            case when checkpoint.run_id is null then null else encode(digest(checkpoint.state::text, 'sha256'), 'hex') end as checkpoint_state_hash,
            retrieval.public_id as context_public_id, retrieval.strategy as context_strategy,
            retrieval.embedding_model as context_embedding_model,
            retrieval.embedding_version as context_embedding_version,
            retrieval.lexical_weight as context_lexical_weight,
            retrieval.semantic_weight as context_semantic_weight,
            coalesce(retrieval.item_count, 0)::int as context_item_count,
            retrieval.purpose as context_purpose,
            retrieval.policy_version as context_policy_version,
            retrieval.policy_decision as context_policy_decision
     from study_runs run
     join study_plan_versions plan on plan.id = run.plan_version_id
     left join study_intent_versions intent on intent.id = run.intent_version_id
     left join context_retrievals intent_context on intent_context.id = intent.context_retrieval_id
     left join workflow_definitions workflow on workflow.id = run.workflow_definition_id
     left join lateral (
       select count(*) as task_count,
              count(*) filter (where task.status in ('completed', 'skipped')) as completed_count,
              count(*) filter (where task.status = 'failed') as failed_count,
              count(*) filter (where task.origin = 'dynamic') as dynamic_count,
              coalesce(sum(greatest(task.attempt - 1, 0)), 0) as retry_count
       from study_tasks task where task.run_id = run.id
     ) task_stats on true
     left join lateral (select count(*) as decision_count from reasoning_decisions decision where decision.run_id = run.id) decision_stats on true
     left join lateral (select count(*) as artifact_count from study_artifacts artifact where artifact.run_id = run.id) artifact_stats on true
     left join lateral (select count(*) as event_count from study_events event where event.run_id = run.id) event_stats on true
     left join lateral (
       select count(*) as invocation_count, count(*) filter (where invocation.status = 'failed') as failed_count
       from study_tool_invocations invocation where invocation.run_id = run.id
     ) invocation_stats on true
     left join study_run_checkpoints checkpoint on checkpoint.run_id = run.id
     left join lateral (
       select context.public_id, context.strategy, context.embedding_model, context.embedding_version,
              context.lexical_weight, context.semantic_weight, context.purpose,
              context.policy_version, context.policy_decision,
              (select count(*) from context_retrieval_items item where item.retrieval_id = context.id) as item_count
       from context_retrievals context where context.run_id = run.id
       order by context.created_at desc, context.id desc limit 1
     ) retrieval on true
     where run.study_id = $1
     order by run.created_at desc, run.id desc`,
    [study.id],
  );
  const runs = runsResult.rows;
  const options = runs.map(optionFromRun);
  if (!runs.length) return { study: { publicId: study.public_id, title: study.title }, options, left: null, right: null, differences: [] };

  const byPublicId = new Map(runs.map((run) => [run.public_id, run]));
  if (requestedLeft && !byPublicId.has(requestedLeft)) return null;
  if (requestedRight && !byPublicId.has(requestedRight)) return null;
  let leftRun = requestedLeft ? byPublicId.get(requestedLeft)! : runs[1] ?? runs[0];
  const rightRun = requestedRight ? byPublicId.get(requestedRight)! : runs[0];
  if (leftRun.id === rightRun.id && runs.length > 1) {
    leftRun = runs.find((run) => run.id !== rightRun.id) ?? leftRun;
  }
  const selectedIds = [...new Set([leftRun.id, rightRun.id])];

  const [tasksResult, decisionsResult, artifactsResult, eventsResult, skillsResult, trajectoryResult] = await Promise.all([
    database.query<{
      run_id: string; task_key: string; title: string; tool_name: string; status: string;
      origin: string; generation: number; attempt: number; output_hash: string;
    }>(
      `select run_id::text as run_id, task_key, title, tool_name, status, origin, generation, attempt,
              encode(digest(output::text, 'sha256'), 'hex') as output_hash
       from study_tasks where run_id = any($1::bigint[]) order by run_id, position, id`,
      [selectedIds],
    ),
    database.query<{
      run_id: string; sequence: number; policy_version: string; action: string; reason: string; created_at: string;
    }>(
      `select run_id::text as run_id, sequence, policy_version,
              coalesce(chosen_action ->> 'type', 'continue') as action,
              reason, created_at::text as created_at
       from reasoning_decisions where run_id = any($1::bigint[]) order by run_id, sequence, id`,
      [selectedIds],
    ),
    database.query<{
      run_id: string; public_id: string; artifact_type: string; title: string; content_hash: string; created_at: string;
    }>(
      `select run_id::text as run_id, public_id, artifact_type, title,
              encode(digest(content::text, 'sha256'), 'hex') as content_hash,
              created_at::text as created_at
       from study_artifacts where run_id = any($1::bigint[]) order by run_id, created_at, id`,
      [selectedIds],
    ),
    database.query<{ run_id: string; id: string; event_type: string; created_at: string }>(
      `select run_id::text as run_id, id::text as id, event_type, created_at::text as created_at
       from study_events where run_id = any($1::bigint[]) order by run_id, created_at, id`,
      [selectedIds],
    ),
    database.query<{ run_id: string; skill_slug: string; skill_version: number }>(
      `select distinct run_id::text as run_id, skill_slug, skill_version
       from study_tool_invocations
       where run_id = any($1::bigint[]) and skill_slug is not null and skill_version is not null
       order by run_id, skill_slug, skill_version`,
      [selectedIds],
    ),
    database.query<{
      run_id: string; public_id: string; evaluator_version: string; controller_mode: "off" | "shadow" | "active";
      metrics: JsonObject | string; created_at: string;
    }>(
      `select run_id::text as run_id, public_id, evaluator_version, controller_mode, metrics,
              created_at::text as created_at
       from research_agent_trajectory_evaluations
       where run_id = any($1::bigint[])
       order by run_id, created_at desc, id desc`,
      [selectedIds],
    ),
  ]);

  const snapshot = (run: RunRow): StudyRunReplaySnapshot => {
    const usage = parseJson(run.usage);
    const started = run.started_at ? new Date(run.started_at).getTime() : null;
    const finished = run.finished_at ? new Date(run.finished_at).getTime() : null;
    return {
      ...optionFromRun(run),
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      durationMs: started !== null && finished !== null ? Math.max(0, finished - started) : null,
      provider: run.provider,
      model: run.provider_model,
      usage,
      totalTokens: totalTokens(usage),
      error: run.error_message,
      plan: {
        productLine: run.product_line,
        schemaVersion: run.plan_schema_version,
        contentHash: run.plan_content_hash,
        snapshotReason: run.plan_snapshot_reason,
        brief: run.brief_snapshot,
        studyType: run.study_type,
        framework: run.framework,
        methods: parseJson(run.methods),
        personaFilters: parseJson(run.persona_filters),
        personaCount: run.persona_count,
        estimatedDurationMinutes: run.estimated_duration_minutes,
        estimatedTokens: Number(run.estimated_tokens),
        source: run.plan_source,
        providerModel: run.plan_provider_model,
        promptVersion: run.plan_prompt_version,
        rationale: run.rationale,
        confirmedAt: run.confirmed_at,
      },
      intent: run.intent_public_id && run.intent_version && run.intent_schema_version && run.intent_content_hash && run.intent_objective ? {
        publicId: run.intent_public_id,
        version: run.intent_version,
        schemaVersion: run.intent_schema_version,
        contentHash: run.intent_content_hash,
        lifecycleStatus: run.intent_lifecycle_status ?? "confirmed",
        objective: run.intent_objective,
        contextRetrievalPublicId: run.intent_context_public_id,
        contextCitationCount: run.intent_context_item_count,
      } : null,
      workflowDefinition: run.workflow_definition_public_id && run.workflow_definition_version
        && run.workflow_definition_schema_version && run.workflow_definition_content_hash
        && run.workflow_definition_template_version && run.workflow_definition_compiler_version ? {
          publicId: run.workflow_definition_public_id,
          version: run.workflow_definition_version,
          schemaVersion: run.workflow_definition_schema_version,
          contentHash: run.workflow_definition_content_hash,
          templateVersion: run.workflow_definition_template_version,
          compilerVersion: run.workflow_definition_compiler_version,
          taskCount: run.workflow_definition_task_count,
          skillRequirements: run.workflow_definition_skills ? parseJson(run.workflow_definition_skills) : [],
        } : null,
      versions: {
        workflowType: run.workflow_type,
        workflowVersion: run.workflow_version,
        strategyKey: run.strategy_key,
        strategyVersion: run.strategy_version,
        reasoningPolicyVersion: run.reasoning_policy_version,
        promptVersion: run.prompt_version,
      },
      counts: {
        tasks: run.task_count,
        completedTasks: run.completed_task_count,
        failedTasks: run.failed_task_count,
        dynamicTasks: run.dynamic_task_count,
        taskRetries: run.task_retry_count,
        decisions: run.decision_count,
        artifacts: run.artifact_count,
        events: run.event_count,
        invocations: run.invocation_count,
        failedInvocations: run.failed_invocation_count,
      },
      checkpoint: { cursor: run.checkpoint_cursor, stateHash: run.checkpoint_state_hash },
      context: run.context_public_id && run.context_strategy ? {
        publicId: run.context_public_id,
        strategy: run.context_strategy,
        embeddingModel: run.context_embedding_model,
        embeddingVersion: run.context_embedding_version,
        lexicalWeight: run.context_lexical_weight,
        semanticWeight: run.context_semantic_weight,
        itemCount: run.context_item_count,
        purpose: run.context_purpose ?? "general",
        policyVersion: run.context_policy_version ?? "memory-policy-v1",
        policyDecision: run.context_policy_decision ? parseJson(run.context_policy_decision) : {},
      } : null,
      skills: skillsResult.rows.filter((row) => row.run_id === run.id).map((row) => ({ slug: row.skill_slug, version: row.skill_version })),
      tasks: tasksResult.rows.filter((row) => row.run_id === run.id).map((task) => ({
        key: task.task_key, title: task.title, toolName: task.tool_name, status: task.status,
        origin: task.origin, generation: task.generation, attempt: task.attempt, outputHash: task.output_hash,
      })),
      decisions: decisionsResult.rows.filter((row) => row.run_id === run.id).map((decision) => ({
        sequence: decision.sequence, policyVersion: decision.policy_version, action: decision.action,
        reason: decision.reason, createdAt: decision.created_at,
      })),
      artifacts: artifactsResult.rows.filter((row) => row.run_id === run.id).map((artifact) => ({
        publicId: artifact.public_id, type: artifact.artifact_type, title: artifact.title,
        contentHash: artifact.content_hash, createdAt: artifact.created_at,
      })),
      timeline: eventsResult.rows.filter((row) => row.run_id === run.id).map((event) => ({
        id: event.id, type: event.event_type, createdAt: event.created_at,
      })),
      trajectoryEvaluation: (() => {
        const evaluation = trajectoryResult.rows.find((row) => row.run_id === run.id);
        return evaluation ? {
          publicId: evaluation.public_id,
          evaluatorVersion: evaluation.evaluator_version,
          controllerMode: evaluation.controller_mode,
          metrics: parseJson(evaluation.metrics),
          createdAt: evaluation.created_at,
        } : null;
      })(),
    };
  };

  const left = snapshot(leftRun);
  const right = leftRun.id === rightRun.id ? left : snapshot(rightRun);
  return {
    study: { publicId: study.public_id, title: study.title },
    options,
    left,
    right,
    differences: compareSnapshots(left, right),
  };
}
