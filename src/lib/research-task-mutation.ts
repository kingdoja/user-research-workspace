import type { Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export type DynamicTaskMutationDefinition = {
  key: string;
  title: string;
  toolName: string;
  template?: string | null;
  dependsOn: string[];
  input: Record<string, unknown>;
};

export type DynamicTaskMutationResult = {
  taskKeys: string[];
  generation: number;
  reasoningDecisionId: string | null;
};

export type DynamicTaskMutationErrorCode =
  | "DYNAMIC_TASKS_EMPTY"
  | "DYNAMIC_TASK_RUN_NOT_FOUND"
  | "DYNAMIC_TASK_GATE_NOT_OPEN"
  | "DYNAMIC_TASK_LIMIT_REACHED"
  | "DYNAMIC_TASK_TOOL_NOT_ALLOWED"
  | "DYNAMIC_TASK_KEY_CONFLICT"
  | "DYNAMIC_TASK_DEPENDENCY_UNKNOWN"
  | "DYNAMIC_TASK_DEPENDENCY_NOT_COMPLETED";

export class DynamicTaskMutationError extends Error {
  constructor(readonly code: DynamicTaskMutationErrorCode) {
    super(code);
    this.name = "DynamicTaskMutationError";
  }
}

export function dynamicTaskMutationRejectionReason(error: unknown): string | null {
  if (!(error instanceof DynamicTaskMutationError)) return null;
  switch (error.code) {
    case "DYNAMIC_TASKS_EMPTY": return "replan_requires_tasks";
    case "DYNAMIC_TASK_RUN_NOT_FOUND": return "run_not_found";
    case "DYNAMIC_TASK_GATE_NOT_OPEN": return "report_gate_not_open";
    case "DYNAMIC_TASK_LIMIT_REACHED": return "dynamic_task_limit_reached";
    case "DYNAMIC_TASK_TOOL_NOT_ALLOWED": return "tool_not_allowed";
    case "DYNAMIC_TASK_KEY_CONFLICT": return "task_key_conflict";
    case "DYNAMIC_TASK_DEPENDENCY_UNKNOWN": return "dependency_unknown";
    case "DYNAMIC_TASK_DEPENDENCY_NOT_COMPLETED": return "dependency_not_completed";
  }
}

export async function appendGovernedDynamicTasks(input: {
  queryable: Queryable;
  studyId: string;
  runId: string;
  definitions: DynamicTaskMutationDefinition[];
  timeoutSeconds: number;
  maxDynamicTasks: number;
  gateTaskKey: string;
  allowedToolNames: readonly string[];
  origin?: "dynamic";
  generation?: number;
  reasoningDecisionId?: string | null;
  policyVersion?: string | null;
  source: string;
}): Promise<DynamicTaskMutationResult> {
  if (!input.definitions.length) throw new DynamicTaskMutationError("DYNAMIC_TASKS_EMPTY");

  const lockedRun = await input.queryable.query<{ id: string }>(
    "select id::text as id from study_runs where id = $1 and study_id = $2 for update",
    [input.runId, input.studyId],
  );
  if (!lockedRun.rows[0]) throw new DynamicTaskMutationError("DYNAMIC_TASK_RUN_NOT_FOUND");

  const gateResult = await input.queryable.query<{ key: string; position: number }>(
    `select task_key as key, position
     from study_tasks
     where run_id = $1 and status = 'pending' and task_key = $2
     order by position, id limit 1`,
    [input.runId, input.gateTaskKey],
  );
  const reportGate = gateResult.rows[0];
  if (!reportGate) throw new DynamicTaskMutationError("DYNAMIC_TASK_GATE_NOT_OPEN");

  const existingResult = await input.queryable.query<{
    task_key: string;
    position: number;
    generation: number;
    origin: string;
    status: string;
  }>(
    `select task_key, position, generation, origin, status
     from study_tasks where run_id = $1 order by position, id`,
    [input.runId],
  );
  const dynamicTaskCount = existingResult.rows.filter((row) => row.origin === "dynamic").length;
  if (dynamicTaskCount + input.definitions.length > input.maxDynamicTasks) {
    throw new DynamicTaskMutationError("DYNAMIC_TASK_LIMIT_REACHED");
  }
  const existingKeys = new Set(existingResult.rows.map((row) => row.task_key));
  const requestedKeys = new Set<string>();
  const allowedTools = new Set(input.allowedToolNames);
  for (const definition of input.definitions) {
    if (!allowedTools.has(definition.toolName)) throw new DynamicTaskMutationError("DYNAMIC_TASK_TOOL_NOT_ALLOWED");
    if (existingKeys.has(definition.key) || requestedKeys.has(definition.key)) {
      throw new DynamicTaskMutationError("DYNAMIC_TASK_KEY_CONFLICT");
    }
    for (const dependency of definition.dependsOn) {
      if (dependency === definition.key || (!existingKeys.has(dependency) && !requestedKeys.has(dependency))) {
        throw new DynamicTaskMutationError("DYNAMIC_TASK_DEPENDENCY_UNKNOWN");
      }
      const existingDependency = existingResult.rows.find((row) => row.task_key === dependency);
      if (existingDependency && !["completed", "skipped"].includes(existingDependency.status)) {
        throw new DynamicTaskMutationError("DYNAMIC_TASK_DEPENDENCY_NOT_COMPLETED");
      }
    }
    requestedKeys.add(definition.key);
  }

  const generation = input.generation ?? Math.max(0, ...existingResult.rows.map((row) => row.generation)) + 1;
  const count = input.definitions.length;
  await input.queryable.query(
    "update study_tasks set position = position + 10000 where run_id = $1 and position >= $2",
    [input.runId, reportGate.position],
  );
  await input.queryable.query(
    "update study_tasks set position = position - 10000 + $2 where run_id = $1 and position >= $3",
    [input.runId, count, reportGate.position + 10000],
  );
  for (const [offset, definition] of input.definitions.entries()) {
    await input.queryable.query(
      `insert into study_tasks (
         public_id, study_id, run_id, position, task_key, title, tool_name, depends_on, input,
         timeout_seconds, origin, generation, reasoning_decision_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)`,
      [
        createPublicId("tsk"),
        input.studyId, input.runId, reportGate.position + offset, definition.key, definition.title,
        definition.toolName, JSON.stringify(definition.dependsOn), JSON.stringify(definition.input),
        input.timeoutSeconds, input.origin ?? "dynamic", generation, input.reasoningDecisionId ?? null,
      ],
    );
  }
  await input.queryable.query(
    `update study_tasks
     set depends_on = (
       select jsonb_agg(value order by ord)
       from (
         select value, ord
         from jsonb_array_elements(depends_on) with ordinality as existing(value, ord)
         union all
         select to_jsonb(requested.value), 100000::bigint + requested.ord
         from jsonb_array_elements_text($3::jsonb) with ordinality as requested(value, ord)
       ) ordered
     ), updated_at = now()
     where run_id = $1 and task_key = $2`,
    [input.runId, reportGate.key, JSON.stringify(input.definitions.map((definition) => definition.key))],
  );
  await input.queryable.query(
    `update study_runs set dynamic_task_count = dynamic_task_count + $2,
            reasoning_policy_version = coalesce($3, reasoning_policy_version), expansion_stop_reason = null
     where id = $1`,
    [input.runId, count, input.policyVersion ?? null],
  );
  await input.queryable.query(
    `insert into study_events (study_id, run_id, event_type, payload)
     values ($1, $2, 'tasks.mutation.applied', $3::jsonb)`,
    [input.studyId, input.runId, JSON.stringify({
      source: input.source,
      taskKeys: input.definitions.map((definition) => definition.key),
      generation,
      reasoningDecisionId: input.reasoningDecisionId ?? null,
      templates: input.definitions.map((definition) => ({ key: definition.key, template: definition.template ?? null })),
    })],
  );
  return {
    taskKeys: input.definitions.map((definition) => definition.key),
    generation,
    reasoningDecisionId: input.reasoningDecisionId ?? null,
  };
}
