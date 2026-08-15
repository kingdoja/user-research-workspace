import { createHash, randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { WorkflowType } from "@/lib/research-types";

export type { WorkflowType } from "@/lib/research-types";

export type StrategyAssignment = {
  assignmentId: string | null;
  assignmentPublicId: string | null;
  experimentKey: string | null;
  variantKey: string;
  strategyVersion: string;
  config: Record<string, unknown>;
};

export type StrategyVariantMetrics = {
  assignments: number;
  completed: number;
  failed: number;
  cancelled: number;
  completionRate: number;
  averageDurationMs: number | null;
  averageTokens: number | null;
  averageTaskCount: number | null;
  averageQualityScore: number | null;
  averageSessionTurns: number | null;
  averageQuestionCoverage: number | null;
  averageFollowupHitRate: number | null;
  averageTaskInvocations: number | null;
  averageTaskFailures: number | null;
  averageTaskRetries: number | null;
  averageRetryRate: number | null;
};

export type StrategyExperimentSummary = {
  publicId: string;
  experimentKey: string;
  name: string;
  description: string;
  workflowType: WorkflowType;
  status: string;
  variants: Array<{
    variantKey: string;
    name: string;
    strategyVersion: string;
    weight: number;
    config: Record<string, unknown>;
    metrics: StrategyVariantMetrics;
  }>;
};

function integerEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function getRuntimeLimits() {
  return {
    taskConcurrency: integerEnv("RESEARCH_TASK_CONCURRENCY", 2, 1, 8),
    workspaceRunConcurrency: integerEnv("RESEARCH_WORKSPACE_CONCURRENCY", 2, 1, 20),
    providerRunConcurrency: integerEnv("RESEARCH_PROVIDER_CONCURRENCY", 4, 1, 100),
    providerRequestsPerMinute: integerEnv("RESEARCH_PROVIDER_RPM", 30, 1, 10000),
    taskTimeoutSeconds: integerEnv("RESEARCH_TASK_TIMEOUT_SECONDS", 300, 15, 3600),
    runTimeoutSeconds: integerEnv("RESEARCH_RUN_TIMEOUT_SECONDS", 1800, 30, 14400),
  };
}

export async function acquireProviderRuntimeSlot(input: {
  runId: string;
  workspaceId: string;
  providerName: string;
  workerId: string;
}) {
  const limits = getRuntimeLimits();
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtext($1))", [`runtime:provider:${input.providerName}`]);
    await transaction.query("select pg_advisory_xact_lock(hashtext($1))", [`runtime:workspace:${input.workspaceId}`]);
    await transaction.query("delete from provider_runtime_slots where lease_expires_at < now()");
    const existing = await transaction.query<{ id: string; lease_owner: string }>(
      `select id::text as id, lease_owner from provider_runtime_slots
       where run_id = $1 and lease_expires_at > now() limit 1`,
      [input.runId],
    );
    if (existing.rows[0]?.lease_owner === input.workerId) return { acquired: true as const, reason: null };
    if (existing.rows[0]) return { acquired: false as const, reason: "run_leased" as const };
    const counts = await transaction.query<{ workspace_count: number; provider_count: number }>(
      `select
         count(*) filter (where workspace_id = $1)::int as workspace_count,
         count(*) filter (where provider_name = $2)::int as provider_count
       from provider_runtime_slots where lease_expires_at > now()`,
      [input.workspaceId, input.providerName],
    );
    const count = counts.rows[0];
    if (count.workspace_count >= limits.workspaceRunConcurrency) {
      return { acquired: false as const, reason: "workspace_concurrency" as const };
    }
    if (count.provider_count >= limits.providerRunConcurrency) {
      return { acquired: false as const, reason: "provider_concurrency" as const };
    }
    await transaction.query(
      `insert into provider_runtime_slots (
         run_id, workspace_id, provider_name, lease_owner, lease_expires_at
       ) values ($1, $2, $3, $4, now() + interval '10 minutes')
       on conflict (run_id) do update set
         workspace_id = excluded.workspace_id, provider_name = excluded.provider_name,
         lease_owner = excluded.lease_owner, lease_expires_at = excluded.lease_expires_at,
         updated_at = now()`,
      [input.runId, input.workspaceId, input.providerName, input.workerId],
    );
    return { acquired: true as const, reason: null };
  });
}

export async function renewProviderRuntimeSlot(runId: string, workerId: string) {
  const database = await getDatabase();
  await database.query(
    `update provider_runtime_slots set lease_expires_at = now() + interval '10 minutes', updated_at = now()
     where run_id = $1 and lease_owner = $2`,
    [runId, workerId],
  );
}

export async function releaseProviderRuntimeSlot(runId: string, workerId: string) {
  const database = await getDatabase();
  await database.query("delete from provider_runtime_slots where run_id = $1 and lease_owner = $2", [runId, workerId]);
}

export async function consumeProviderRateToken(
  queryable: Queryable,
  providerName: string,
  workspaceId: string,
) {
  const limit = getRuntimeLimits().providerRequestsPerMinute;
  const result = await queryable.query<{ request_count: number }>(
    `insert into provider_rate_windows (provider_name, workspace_id, window_started_at, request_count)
     values ($1, $2, date_trunc('minute', now()), 1)
     on conflict (provider_name, workspace_id, window_started_at) do update set
       request_count = provider_rate_windows.request_count + 1,
       updated_at = now()
     where provider_rate_windows.request_count < $3
     returning request_count`,
    [providerName, workspaceId, limit],
  );
  return Boolean(result.rows[0]);
}

function allocationNumber(salt: string, subjectKey: string, totalWeight: number) {
  const digest = createHash("sha256").update(`${salt}:${subjectKey}`).digest();
  return digest.readUInt32BE(0) % totalWeight;
}

export async function assignActiveStrategy(input: {
  queryable: Queryable;
  workspaceId: string;
  studyId?: string | null;
  runId?: string | null;
  interviewSessionId?: string | null;
  subjectKey: string;
  workflowType: WorkflowType;
}): Promise<StrategyAssignment> {
  const experiment = await input.queryable.query<{
    id: string; experiment_key: string; allocation_salt: string;
  }>(
    `select id::text as id, experiment_key, allocation_salt
     from strategy_experiments
     where workspace_id = $1 and workflow_type = $2 and status = 'active'
     order by started_at desc nulls last, id desc limit 1`,
    [input.workspaceId, input.workflowType],
  );
  const active = experiment.rows[0];
  if (!active) {
    return {
      assignmentId: null,
      assignmentPublicId: null,
      experimentKey: null,
      variantKey: "default",
      strategyVersion: "v1",
      config: {},
    };
  }
  const existing = await input.queryable.query<{
    id: string; public_id: string; variant_key: string; strategy_version: string; config: Record<string, unknown> | string;
  }>(
    `select assignment.id::text as id, assignment.public_id, variant.variant_key,
            variant.strategy_version, variant.config
     from strategy_assignments assignment
     join strategy_variants variant on variant.id = assignment.variant_id
     where ($1::bigint is not null and assignment.run_id = $1)
        or ($2::bigint is not null and assignment.interview_session_id = $2)
     limit 1`,
    [input.runId ?? null, input.interviewSessionId ?? null],
  );
  let assignment = existing.rows[0];
  if (!assignment) {
    const variants = await input.queryable.query<{
      id: string; variant_key: string; strategy_version: string; weight: number; config: Record<string, unknown> | string;
    }>(
      `select id::text as id, variant_key, strategy_version, weight, config
       from strategy_variants where experiment_id = $1 order by id`,
      [active.id],
    );
    if (!variants.rows.length) throw new Error("EXPERIMENT_VARIANTS_MISSING");
    const totalWeight = variants.rows.reduce((total, variant) => total + variant.weight, 0);
    let bucket = allocationNumber(active.allocation_salt, input.subjectKey, totalWeight);
    const selected = variants.rows.find((variant) => {
      if (bucket < variant.weight) return true;
      bucket -= variant.weight;
      return false;
    }) ?? variants.rows.at(-1)!;
    const inserted = await input.queryable.query<{
      id: string; public_id: string;
    }>(
      `insert into strategy_assignments (
         public_id, experiment_id, variant_id, workspace_id, study_id, run_id,
         interview_session_id, subject_key, allocation_hash
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id::text as id, public_id`,
      [
        createPublicId("asg"), active.id, selected.id, input.workspaceId, input.studyId ?? null,
        input.runId ?? null, input.interviewSessionId ?? null, input.subjectKey,
        createHash("sha256").update(`${active.allocation_salt}:${input.subjectKey}`).digest("hex"),
      ],
    );
    assignment = {
      id: inserted.rows[0].id,
      public_id: inserted.rows[0].public_id,
      variant_key: selected.variant_key,
      strategy_version: selected.strategy_version,
      config: selected.config,
    };
  }
  return {
    assignmentId: assignment.id,
    assignmentPublicId: assignment.public_id,
    experimentKey: active.experiment_key,
    variantKey: assignment.variant_key,
    strategyVersion: assignment.strategy_version,
    config: typeof assignment.config === "string" ? JSON.parse(assignment.config) as Record<string, unknown> : assignment.config,
  };
}

export async function recordStrategyMetric(
  queryable: Queryable,
  assignmentId: string | null,
  metricKey: string,
  metricValue: number,
  metadata: Record<string, unknown> = {},
) {
  if (!assignmentId) return;
  await queryable.query(
    `insert into strategy_metrics (assignment_id, metric_key, metric_value, metadata)
     values ($1, $2, $3, $4::jsonb)
     on conflict (assignment_id, metric_key) do update set
       metric_value = excluded.metric_value, metadata = excluded.metadata, recorded_at = now()`,
    [assignmentId, metricKey, metricValue, JSON.stringify(metadata)],
  );
}

export async function recordBatchTaskMetrics(queryable: Queryable, assignmentId: string | null, runId: string) {
  if (!assignmentId) return null;
  const result = await queryable.query<{ invocations: number; failures: number; retries: number }>(
    `select
       (select count(*)::int from study_tool_invocations where run_id = $1) as invocations,
       (select count(*)::int from study_task_attempts where run_id = $1 and status = 'failed') as failures,
       (select count(*)::int from study_task_attempts where run_id = $1 and attempt > 1) as retries`,
    [runId],
  );
  const row = result.rows[0] ?? { invocations: 0, failures: 0, retries: 0 };
  const invocations = Number(row.invocations);
  const failures = Number(row.failures);
  const retries = Number(row.retries);
  const metadata = { metricVersion: "batch-task-metrics-v1", runId };
  await recordStrategyMetric(queryable, assignmentId, "task_invocations", invocations, metadata);
  await recordStrategyMetric(queryable, assignmentId, "task_failures", failures, metadata);
  await recordStrategyMetric(queryable, assignmentId, "task_retries", retries, metadata);
  await recordStrategyMetric(queryable, assignmentId, "task_retry_rate", invocations ? retries / invocations : 0, metadata);
  return { invocations, failures, retries, retryRate: invocations ? retries / invocations : 0 };
}

export async function createStrategyExperiment(viewer: Viewer, input: {
  experimentKey: string;
  name: string;
  description: string;
  workflowType: WorkflowType;
  variants: Array<{ variantKey: string; name: string; strategyVersion: string; weight: number; config: Record<string, unknown> }>;
}) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const experiment = await transaction.query<{ id: string; public_id: string }>(
      `insert into strategy_experiments (
         public_id, workspace_id, created_by, experiment_key, name, description, workflow_type, allocation_salt
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (workspace_id, experiment_key) do nothing
       returning id::text as id, public_id`,
      [createPublicId("exp"), viewer.workspaceId, viewer.userId, input.experimentKey, input.name, input.description, input.workflowType, randomUUID()],
    );
    if (!experiment.rows[0]) return "conflict" as const;
    for (const variant of input.variants) {
      await transaction.query(
        `insert into strategy_variants (
           public_id, experiment_id, variant_key, name, strategy_version, weight, config
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [createPublicId("var"), experiment.rows[0].id, variant.variantKey, variant.name, variant.strategyVersion, variant.weight, JSON.stringify(variant.config)],
      );
    }
    return { publicId: experiment.rows[0].public_id, status: "draft" as const };
  });
}

export async function updateStrategyExperimentStatus(
  viewer: Viewer,
  publicId: string,
  status: "active" | "paused" | "completed",
) {
  if (viewer.role !== "owner" && viewer.role !== "admin") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const experiment = await transaction.query<{ id: string; workflow_type: WorkflowType }>(
      `select id::text as id, workflow_type from strategy_experiments
       where public_id = $1 and workspace_id = $2 for update`,
      [publicId, viewer.workspaceId],
    );
    if (!experiment.rows[0]) return "not_found" as const;
    if (status === "active") {
      await transaction.query(
        `update strategy_experiments set status = 'paused', updated_at = now()
         where workspace_id = $1 and workflow_type = $2 and status = 'active' and id <> $3`,
        [viewer.workspaceId, experiment.rows[0].workflow_type, experiment.rows[0].id],
      );
    }
    await transaction.query(
      `update strategy_experiments set status = $2,
              started_at = case when $2 = 'active' then coalesce(started_at, now()) else started_at end,
              ended_at = case when $2 = 'completed' then now() else null end,
              updated_at = now()
       where id = $1`,
      [experiment.rows[0].id, status],
    );
    return "updated" as const;
  });
}

export async function listStrategyExperiments(viewer: Viewer): Promise<StrategyExperimentSummary[]> {
  const database = await getDatabase();
  const [result, metricsResult] = await Promise.all([database.query<{
    public_id: string; experiment_key: string; name: string; description: string; workflow_type: WorkflowType;
    status: string; variants: unknown[] | string;
  }>(
    `select experiment.public_id, experiment.experiment_key, experiment.name,
            experiment.description, experiment.workflow_type, experiment.status,
            coalesce(jsonb_agg(jsonb_build_object(
              'variantKey', variant.variant_key, 'name', variant.name,
              'strategyVersion', variant.strategy_version, 'weight', variant.weight,
              'config', variant.config
            ) order by variant.id) filter (where variant.id is not null), '[]'::jsonb) as variants
     from strategy_experiments experiment
     left join strategy_variants variant on variant.experiment_id = experiment.id
     where experiment.workspace_id = $1
     group by experiment.id order by experiment.updated_at desc`,
    [viewer.workspaceId],
  ), database.query<{
    experiment_public_id: string; variant_key: string; assignments: number;
    completed: number; failed: number; cancelled: number;
    avg_duration_ms: number | null; avg_tokens: number | null; avg_task_count: number | null;
    avg_quality_score: number | null; avg_session_turns: number | null;
    avg_question_coverage: number | null; avg_followup_hit_rate: number | null;
    avg_task_invocations: number | null; avg_task_failures: number | null;
    avg_task_retries: number | null; avg_retry_rate: number | null;
  }>(
    `select experiment.public_id as experiment_public_id, variant.variant_key,
            count(distinct assignment.id)::int as assignments,
            count(distinct assignment.id) filter (where coalesce(completed.metric_value, session_completed.metric_value) = 1)::int as completed,
            count(distinct assignment.id) filter (where coalesce(failed.metric_value, session_failed.metric_value) = 1)::int as failed,
            count(distinct assignment.id) filter (where coalesce(cancelled.metric_value, session_cancelled.metric_value) = 1)::int as cancelled,
            avg(coalesce(duration.metric_value, session_duration.metric_value)) as avg_duration_ms,
            avg(coalesce(tokens.metric_value, session_tokens.metric_value)) as avg_tokens,
            avg(task_count.metric_value) as avg_task_count,
            avg(quality.metric_value) as avg_quality_score,
            avg(session_turns.metric_value) as avg_session_turns,
            avg(question_coverage.metric_value) as avg_question_coverage,
            avg(followup_hit.metric_value) as avg_followup_hit_rate,
            avg(task_invocations.metric_value) as avg_task_invocations,
            avg(task_failures.metric_value) as avg_task_failures,
            avg(task_retries.metric_value) as avg_task_retries,
            avg(retry_rate.metric_value) as avg_retry_rate
     from strategy_experiments experiment
     join strategy_variants variant on variant.experiment_id = experiment.id
     left join strategy_assignments assignment on assignment.variant_id = variant.id
     left join strategy_metrics completed on completed.assignment_id = assignment.id and completed.metric_key = 'run_completed'
     left join strategy_metrics session_completed on session_completed.assignment_id = assignment.id and session_completed.metric_key = 'session_completed'
     left join strategy_metrics failed on failed.assignment_id = assignment.id and failed.metric_key = 'run_failed'
     left join strategy_metrics session_failed on session_failed.assignment_id = assignment.id and session_failed.metric_key = 'session_failed'
     left join strategy_metrics cancelled on cancelled.assignment_id = assignment.id and cancelled.metric_key = 'run_cancelled'
     left join strategy_metrics session_cancelled on session_cancelled.assignment_id = assignment.id and session_cancelled.metric_key = 'session_cancelled'
     left join strategy_metrics duration on duration.assignment_id = assignment.id and duration.metric_key = 'run_duration_ms'
     left join strategy_metrics session_duration on session_duration.assignment_id = assignment.id and session_duration.metric_key = 'session_duration_ms'
     left join strategy_metrics tokens on tokens.assignment_id = assignment.id and tokens.metric_key = 'run_tokens'
     left join strategy_metrics session_tokens on session_tokens.assignment_id = assignment.id and session_tokens.metric_key = 'session_tokens'
     left join strategy_metrics task_count on task_count.assignment_id = assignment.id and task_count.metric_key = 'task_count'
     left join strategy_metrics quality on quality.assignment_id = assignment.id and quality.metric_key = 'human_quality_score'
     left join strategy_metrics session_turns on session_turns.assignment_id = assignment.id and session_turns.metric_key = 'session_turns'
     left join strategy_metrics question_coverage on question_coverage.assignment_id = assignment.id and question_coverage.metric_key = 'question_coverage_rate'
     left join strategy_metrics followup_hit on followup_hit.assignment_id = assignment.id and followup_hit.metric_key = 'followup_hit_rate'
     left join strategy_metrics task_invocations on task_invocations.assignment_id = assignment.id and task_invocations.metric_key = 'task_invocations'
     left join strategy_metrics task_failures on task_failures.assignment_id = assignment.id and task_failures.metric_key = 'task_failures'
     left join strategy_metrics task_retries on task_retries.assignment_id = assignment.id and task_retries.metric_key = 'task_retries'
     left join strategy_metrics retry_rate on retry_rate.assignment_id = assignment.id and retry_rate.metric_key = 'task_retry_rate'
     where experiment.workspace_id = $1
     group by experiment.public_id, variant.id, variant.variant_key`,
    [viewer.workspaceId],
  )]);
  const metrics = new Map(metricsResult.rows.map((row) => [`${row.experiment_public_id}:${row.variant_key}`, {
    assignments: row.assignments,
    completed: row.completed,
    failed: row.failed,
    cancelled: row.cancelled,
    completionRate: row.assignments ? row.completed / row.assignments : 0,
    averageDurationMs: row.avg_duration_ms === null ? null : Number(row.avg_duration_ms),
    averageTokens: row.avg_tokens === null ? null : Number(row.avg_tokens),
    averageTaskCount: row.avg_task_count === null ? null : Number(row.avg_task_count),
    averageQualityScore: row.avg_quality_score === null ? null : Number(row.avg_quality_score),
    averageSessionTurns: row.avg_session_turns === null ? null : Number(row.avg_session_turns),
    averageQuestionCoverage: row.avg_question_coverage === null ? null : Number(row.avg_question_coverage),
    averageFollowupHitRate: row.avg_followup_hit_rate === null ? null : Number(row.avg_followup_hit_rate),
    averageTaskInvocations: row.avg_task_invocations === null ? null : Number(row.avg_task_invocations),
    averageTaskFailures: row.avg_task_failures === null ? null : Number(row.avg_task_failures),
    averageTaskRetries: row.avg_task_retries === null ? null : Number(row.avg_task_retries),
    averageRetryRate: row.avg_retry_rate === null ? null : Number(row.avg_retry_rate),
  }]));
  return result.rows.map((row) => ({
    publicId: row.public_id,
    experimentKey: row.experiment_key,
    name: row.name,
    description: row.description,
    workflowType: row.workflow_type,
    status: row.status,
    variants: (typeof row.variants === "string" ? JSON.parse(row.variants) : row.variants as Array<Record<string, unknown>>)
      .map((variant: Record<string, unknown>) => ({
        variantKey: String(variant.variantKey),
        name: String(variant.name),
        strategyVersion: String(variant.strategyVersion),
        weight: Number(variant.weight),
        config: (variant.config ?? {}) as Record<string, unknown>,
        metrics: metrics.get(`${row.public_id}:${String(variant.variantKey)}`) ?? {
          assignments: 0, completed: 0, failed: 0, cancelled: 0, completionRate: 0,
          averageDurationMs: null, averageTokens: null, averageTaskCount: null,
          averageQualityScore: null, averageSessionTurns: null,
          averageQuestionCoverage: null, averageFollowupHitRate: null,
          averageTaskInvocations: null, averageTaskFailures: null,
          averageTaskRetries: null, averageRetryRate: null,
        },
      })),
  }));
}

export async function getStrategyExperimentComparison(viewer: Viewer, experimentPublicId: string) {
  const database = await getDatabase();
  const [experiments, sessionsResult] = await Promise.all([
    listStrategyExperiments(viewer),
    database.query<{
      session_public_id: string;
      project_public_id: string;
      project_title: string;
      participant_name: string | null;
      status: string;
      started_at: string | null;
      completed_at: string | null;
      turn_count: number;
      context_retrieval_public_id: string | null;
      workflow_version: string;
      skill_slug: string | null;
      skill_version: number | null;
      strategy_key: string;
      strategy_version: string;
      variant_key: string;
      assignment_public_id: string;
      latest_quality_score: number | null;
      question_coverage_rate: number | null;
      followup_hit_rate: number | null;
      task_retries: number | null;
    }>(
      `select session.public_id as session_public_id, project.public_id as project_public_id,
              project.title as project_title, session.participant_name, session.status,
              session.started_at::text as started_at, session.completed_at::text as completed_at,
              (select count(*)::int from interview_messages message where message.session_id = session.id) as turn_count,
              retrieval.public_id as context_retrieval_public_id, session.workflow_version,
              session.skill_slug, session.skill_version, session.strategy_key, session.strategy_version,
              variant.variant_key, assignment.public_id as assignment_public_id,
              latest_review.overall_score as latest_quality_score,
              session_metrics.coverage_rate as question_coverage_rate,
              session_metrics.followup_hit_rate,
              assignment_task_metrics.metric_value as task_retries
       from strategy_experiments experiment
       join strategy_variants variant on variant.experiment_id = experiment.id
       join strategy_assignments assignment on assignment.variant_id = variant.id
       join interview_sessions session on session.id = assignment.interview_session_id
       join interview_projects project on project.id = session.project_id
       left join context_retrievals retrieval on retrieval.id = session.context_retrieval_id
       left join lateral (
         select review.overall_score from interview_quality_reviews review
         where review.session_id = session.id order by review.updated_at desc limit 1
       ) latest_review on true
       left join interview_session_metrics session_metrics on session_metrics.session_id = session.id
       left join strategy_metrics assignment_task_metrics
         on assignment_task_metrics.assignment_id = assignment.id and assignment_task_metrics.metric_key = 'task_retries'
       where experiment.public_id = $1 and experiment.workspace_id = $2
       order by variant.id, session.created_at desc, session.id desc`,
      [experimentPublicId, viewer.workspaceId],
    ),
  ]);
  const experiment = experiments.find((item) => item.publicId === experimentPublicId);
  if (!experiment) return null;
  const sessions = sessionsResult.rows.map((row) => ({
    sessionPublicId: row.session_public_id,
    projectPublicId: row.project_public_id,
    projectTitle: row.project_title,
    participantName: row.participant_name?.trim() || "匿名参与者",
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    turnCount: row.turn_count,
    contextRetrievalPublicId: row.context_retrieval_public_id,
    workflowVersion: row.workflow_version,
    skill: row.skill_slug ? { slug: row.skill_slug, version: row.skill_version } : null,
    strategyKey: row.strategy_key,
    strategyVersion: row.strategy_version,
    variantKey: row.variant_key,
    assignmentPublicId: row.assignment_public_id,
    latestQualityScore: row.latest_quality_score === null ? null : Number(row.latest_quality_score),
    questionCoverageRate: row.question_coverage_rate === null ? null : Number(row.question_coverage_rate),
    followupHitRate: row.followup_hit_rate === null ? null : Number(row.followup_hit_rate),
    taskRetries: row.task_retries === null ? null : Number(row.task_retries),
  }));
  return {
    experiment,
    variants: experiment.variants.map((variant) => ({
      ...variant,
      sessions: sessions.filter((session) => session.variantKey === variant.variantKey),
    })),
  };
}
