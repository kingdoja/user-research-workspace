import { createHash, randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export type WorkflowType = "realtime_agent" | "batch_research";

export type StrategyAssignment = {
  assignmentId: string | null;
  assignmentPublicId: string | null;
  experimentKey: string | null;
  variantKey: string;
  strategyVersion: string;
  config: Record<string, unknown>;
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
  studyId: string;
  runId: string;
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
     where assignment.run_id = $1 limit 1`,
    [input.runId],
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
         public_id, experiment_id, variant_id, workspace_id, study_id, run_id, subject_key, allocation_hash
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (run_id) do update set subject_key = excluded.subject_key
       returning id::text as id, public_id`,
      [
        createPublicId("asg"), active.id, selected.id, input.workspaceId, input.studyId, input.runId,
        input.subjectKey, createHash("sha256").update(`${active.allocation_salt}:${input.subjectKey}`).digest("hex"),
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

export async function listStrategyExperiments(viewer: Viewer) {
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
  }>(
    `select experiment.public_id as experiment_public_id, variant.variant_key,
            count(distinct assignment.id)::int as assignments,
            count(distinct assignment.id) filter (where completed.metric_value = 1)::int as completed,
            count(distinct assignment.id) filter (where failed.metric_value = 1)::int as failed,
            count(distinct assignment.id) filter (where cancelled.metric_value = 1)::int as cancelled,
            avg(duration.metric_value) as avg_duration_ms,
            avg(tokens.metric_value) as avg_tokens,
            avg(task_count.metric_value) as avg_task_count
     from strategy_experiments experiment
     join strategy_variants variant on variant.experiment_id = experiment.id
     left join strategy_assignments assignment on assignment.variant_id = variant.id
     left join strategy_metrics completed on completed.assignment_id = assignment.id and completed.metric_key = 'run_completed'
     left join strategy_metrics failed on failed.assignment_id = assignment.id and failed.metric_key = 'run_failed'
     left join strategy_metrics cancelled on cancelled.assignment_id = assignment.id and cancelled.metric_key = 'run_cancelled'
     left join strategy_metrics duration on duration.assignment_id = assignment.id and duration.metric_key = 'run_duration_ms'
     left join strategy_metrics tokens on tokens.assignment_id = assignment.id and tokens.metric_key = 'run_tokens'
     left join strategy_metrics task_count on task_count.assignment_id = assignment.id and task_count.metric_key = 'task_count'
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
        ...variant,
        metrics: metrics.get(`${row.public_id}:${String(variant.variantKey)}`) ?? {
          assignments: 0, completed: 0, failed: 0, cancelled: 0, completionRate: 0,
          averageDurationMs: null, averageTokens: null, averageTaskCount: null,
        },
      })),
  }));
}
