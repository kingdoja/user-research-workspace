import type { Queryable } from "@/lib/db";
import { assessResearchAgentRolloutQuality } from "@/lib/research-agent-controller";

type JsonRecord = Record<string, unknown>;

function parseMetrics(value: JsonRecord | string): JsonRecord {
  return typeof value === "string" ? JSON.parse(value) as JsonRecord : value;
}

export function countConsecutivePassingActiveRuns(
  metrics: JsonRecord[],
  strategyConfig: JsonRecord,
) {
  let count = 0;
  for (const item of metrics) {
    if (!assessResearchAgentRolloutQuality({ metrics: [item], strategyConfig }).passed) break;
    count += 1;
  }
  return count;
}

export async function getResearchAgentVariantRolloutReport(input: {
  queryable: Queryable;
  workspaceId: string;
  variantKey: string;
  strategyVersion: string;
  strategyConfig: JsonRecord;
}) {
  const configuredLimit = Number(input.strategyConfig.agentControllerShadowMinRuns ?? 3);
  const limit = Number.isFinite(configuredLimit) ? Math.max(1, Math.min(20, Math.round(configuredLimit))) : 3;
  const workerRows = await input.queryable.query<{
      run_id: string;
      controller_mode: "off" | "shadow" | "active";
      created_at: string;
      metrics: JsonRecord | string;
    }>(
      `select evaluation.run_id::text as run_id, evaluation.controller_mode,
              evaluation.created_at::text as created_at, evaluation.metrics
       from research_agent_trajectory_evaluations evaluation
       join study_runs run on run.id = evaluation.run_id
       where evaluation.workspace_id = $1
         and run.strategy_key = $2
         and run.strategy_version = $3
         and evaluation.evaluator_version = 'research-agent-trajectory-v1'
         and evaluation.metrics->>'executionSource' = 'worker'
       order by evaluation.created_at desc, evaluation.id desc
       limit 100`,
      [input.workspaceId, input.variantKey, input.strategyVersion],
    );
  const localProbe = await input.queryable.query<{ count: number }>(
      `select count(*)::int as count
       from research_agent_trajectory_evaluations evaluation
       join study_runs run on run.id = evaluation.run_id
       where evaluation.workspace_id = $1
         and run.strategy_key = $2
         and run.strategy_version = $3
         and evaluation.evaluator_version = 'research-agent-trajectory-v1'
         and evaluation.metrics->>'executionSource' = 'local_harness_probe'`,
      [input.workspaceId, input.variantKey, input.strategyVersion],
    );
  const fallbackRows = await input.queryable.query<{ run_id: string; created_at: string; reason: string }>(
      `select event.run_id::text as run_id, event.created_at::text as created_at,
              event.payload->'agentController'->>'rolloutReason' as reason
       from study_events event
       join study_runs run on run.id = event.run_id
       join studies study on study.id = run.study_id
       where study.workspace_id = $1
         and run.strategy_key = $2
         and run.strategy_version = $3
         and event.event_type in ('run.started', 'run.resumed')
         and event.payload->'agentController'->>'requestedMode' = 'active'
         and event.payload->'agentController'->>'mode' = 'shadow'
       order by event.created_at desc, event.id desc
       limit 20`,
      [input.workspaceId, input.variantKey, input.strategyVersion],
    );
  const evaluations = workerRows.rows.map((row) => ({
    runId: row.run_id,
    controllerMode: row.controller_mode,
    createdAt: row.created_at,
    metrics: parseMetrics(row.metrics),
  }));
  const bucket = (mode: "shadow" | "active") => {
    const items = evaluations.filter((item) => item.controllerMode === mode);
    const recentMetrics = items.slice(0, limit).map((item) => ({ ...item.metrics, controllerMode: mode }));
    return {
      sampleCount: items.length,
      recentSampleCount: recentMetrics.length,
      quality: assessResearchAgentRolloutQuality({ metrics: recentMetrics, strategyConfig: input.strategyConfig }),
      runs: items.slice(0, limit),
    };
  };
  const shadow = bucket("shadow");
  const active = bucket("active");
  return {
    workerSampleCount: evaluations.length,
    localProbeCount: localProbe.rows[0]?.count ?? 0,
    shadow,
    active: {
      ...active,
      consecutivePassingRuns: countConsecutivePassingActiveRuns(
        evaluations.filter((item) => item.controllerMode === "active").map((item) => ({ ...item.metrics, controllerMode: "active" })),
        input.strategyConfig,
      ),
    },
    automaticFallbacks: fallbackRows.rows.map((row) => ({
      runId: row.run_id,
      createdAt: row.created_at,
      reason: row.reason,
    })),
  };
}
