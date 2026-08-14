import { createPublicId } from "@/lib/identifiers";
import type { Queryable } from "@/lib/db";

export const REASONING_POLICY_VERSION = "deterministic-research-v1";

type StoredReasoningTask = {
  id: string;
  key: string;
  title: string;
  toolName: string;
  status: string;
  position: number;
  dependsOn: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  origin: "planned" | "dynamic";
  generation: number;
};

export type ReasoningCandidate = {
  actionType: "continue" | "append_task" | "stop_expansion" | "finish_run";
  score: number;
  allowed: boolean;
  selected: boolean;
  payload: Record<string, unknown>;
  rejectionReasons: string[];
};

export type ReasoningDecisionResult = {
  publicId: string;
  decisionKey: string;
  sequence: number;
  chosenAction: ReasoningCandidate["actionType"];
  reason: string;
  appendedTaskKey: string | null;
  reused: boolean;
};

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function totalTokens(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if ("total_tokens" in value && typeof value.total_tokens === "number") return value.total_tokens;
  if ("totalTokens" in value && typeof value.totalTokens === "number") return value.totalTokens;
  return 0;
}

function outputTokens(output: Record<string, unknown>) {
  return totalTokens(output.usage);
}

function sourceUrls(task: StoredReasoningTask) {
  const sources = Array.isArray(task.output.sources) ? task.output.sources : [];
  return sources.flatMap((source) => {
    if (!source || typeof source !== "object" || !("url" in source) || typeof source.url !== "string") return [];
    return [source.url];
  });
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function discussionConflict(output: Record<string, unknown>) {
  const disagreements = Array.isArray(output.disagreements) ? output.disagreements.length : 0;
  return Math.min(1, disagreements / 4);
}

function validationConflict(output: Record<string, unknown>) {
  const directions = Array.isArray(output.directions) ? output.directions : [];
  if (!directions.length) return 0;
  const contested = directions.filter((direction) => (
    direction && typeof direction === "object" && "verdict" in direction
      && (direction.verdict === "mixed" || direction.verdict === "weak")
  )).length;
  return contested / directions.length;
}

function nextGate(tasks: StoredReasoningTask[]) {
  return tasks.find((task) => task.status === "pending" && task.key === "persona_search")
    ?? tasks.find((task) => task.status === "pending" && task.key === "report")
    ?? null;
}

async function loadTasks(queryable: Queryable, runId: string): Promise<StoredReasoningTask[]> {
  const result = await queryable.query<{
    id: string; task_key: string; title: string; tool_name: string; status: string; position: number;
    depends_on: string[] | string; input: Record<string, unknown> | string;
    output: Record<string, unknown> | string; origin: "planned" | "dynamic"; generation: number;
  }>(
    `select id::text as id, task_key, title, tool_name, status, position, depends_on,
            input, output, origin, generation
     from study_tasks where run_id = $1 order by position, id`,
    [runId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    key: row.task_key,
    title: row.title,
    toolName: row.tool_name,
    status: row.status,
    position: row.position,
    dependsOn: parseJson(row.depends_on),
    input: parseJson(row.input),
    output: parseJson(row.output),
    origin: row.origin,
    generation: row.generation,
  }));
}

async function existingDecision(queryable: Queryable, runId: string, decisionKey: string) {
  const result = await queryable.query<{
    public_id: string; sequence: number; chosen_action: { type?: string; taskKey?: string } | string; reason: string;
  }>(
    `select public_id, sequence, chosen_action, reason
     from reasoning_decisions where run_id = $1 and decision_key = $2 limit 1`,
    [runId, decisionKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  const action = parseJson(row.chosen_action);
  return {
    publicId: row.public_id,
    decisionKey,
    sequence: row.sequence,
    chosenAction: (action.type ?? "continue") as ReasoningDecisionResult["chosenAction"],
    reason: row.reason,
    appendedTaskKey: typeof action.taskKey === "string" ? action.taskKey : null,
    reused: true,
  };
}

export async function evaluateReasoningCheckpoint(queryable: Queryable, input: {
  workspaceId: string;
  studyId: string;
  runId: string;
  strategyConfig?: Record<string, unknown>;
  tokenBudget?: number;
  elapsedMs?: number;
  triggerType?: "checkpoint" | "resume" | "terminal";
}): Promise<ReasoningDecisionResult> {
  const tasks = await loadTasks(queryable, input.runId);
  const artifacts = await queryable.query<{ public_id: string; artifact_type: string; task_key: string | null }>(
    `select artifact.public_id, artifact.artifact_type, task.task_key
     from study_artifacts artifact
     left join study_tasks task on task.id = artifact.task_id
     where artifact.run_id = $1 order by artifact.created_at, artifact.id`,
    [input.runId],
  );
  const completedKeys = tasks.filter((task) => task.status === "completed" || task.status === "skipped").map((task) => task.key).sort();
  const decisionKey = `checkpoint:${completedKeys.join(",") || "initial"}`;
  const reused = await existingDecision(queryable, input.runId, decisionKey);
  if (reused) return reused;

  const researchTasks = tasks.filter((task) => task.toolName === "deepResearch" || task.toolName === "scoutSocialTrends");
  const completedResearch = researchTasks.filter((task) => task.status === "completed");
  const urls = [...new Set(completedResearch.flatMap(sourceUrls))];
  const domains = [...new Set(urls.map(hostname).filter(Boolean))];
  const tokenUsage = tasks.reduce((sum, task) => sum + outputTokens(task.output), 0);
  const dynamicTaskCount = tasks.filter((task) => task.origin === "dynamic").length;
  const unfinished = tasks.filter((task) => task.status !== "completed" && task.status !== "skipped");
  const reportCompleted = tasks.some((task) => task.key === "report" && task.status === "completed");
  const researchComplete = researchTasks.length > 0 && researchTasks.every((task) => task.status === "completed" || task.status === "skipped");
  const latestCompleted = tasks.filter((task) => task.status === "completed").at(-1);
  const expansionCheckpoint = latestCompleted?.toolName === "deepResearch" || latestCompleted?.toolName === "scoutSocialTrends";
  const latestResearch = completedResearch.at(-1);
  const earlierUrls = new Set(completedResearch.slice(0, -1).flatMap(sourceUrls));
  const latestUrls = latestResearch ? [...new Set(sourceUrls(latestResearch))] : [];
  const noveltyScore = latestUrls.length ? latestUrls.filter((url) => !earlierUrls.has(url)).length / latestUrls.length : 0;
  const minSources = numberInRange(input.strategyConfig?.minEvidenceSources, 6, 1, 50);
  const minDomains = numberInRange(input.strategyConfig?.minEvidenceDomains, 3, 1, 20);
  const maxDynamicTasks = numberInRange(input.strategyConfig?.maxDynamicTasks, 1, 0, 4);
  const configuredBudget = numberInRange(input.strategyConfig?.maxRunTokens, input.tokenBudget ?? 180_000, 1_000, 2_000_000);
  const coverageScore = (Math.min(1, urls.length / minSources) + Math.min(1, domains.length / minDomains)) / 2;
  const validation = tasks.find((task) => task.key === "validation" && task.status === "completed");
  const discussion = tasks.find((task) => task.key === "discussion" && task.status === "completed");
  const conflictScore = Math.max(
    validation ? validationConflict(validation.output) : 0,
    discussion ? discussionConflict(discussion.output) : 0,
  );
  const budgetRemaining = Math.max(0, configuredBudget - tokenUsage);
  const budgetExhausted = tokenUsage >= configuredBudget;
  const gate = nextGate(tasks);
  const canAppend = expansionCheckpoint && researchComplete && !reportCompleted && Boolean(gate)
    && coverageScore < 1 && dynamicTaskCount < maxDynamicTasks && !budgetExhausted;

  const appendPayload = {
    template: "targeted_research_v1",
    toolName: researchTasks[0]?.toolName ?? "deepResearch",
    gateTaskKey: gate?.key ?? null,
    gaps: {
      sources: Math.max(0, minSources - urls.length),
      domains: Math.max(0, minDomains - domains.length),
    },
  };
  const appendRejections = [
    ...(!researchComplete ? ["initial_research_incomplete"] : []),
    ...(!expansionCheckpoint ? ["not_evidence_checkpoint"] : []),
    ...(reportCompleted ? ["report_already_completed"] : []),
    ...(!gate ? ["no_pending_gate"] : []),
    ...(coverageScore >= 1 ? ["coverage_satisfied"] : []),
    ...(dynamicTaskCount >= maxDynamicTasks ? ["dynamic_task_limit_reached"] : []),
    ...(budgetExhausted ? ["token_budget_exhausted"] : []),
  ];
  let chosenAction: ReasoningCandidate["actionType"] = "continue";
  let reason = "固定 DAG 仍有必需任务，当前 checkpoint 不需要扩展任务。";
  if (!unfinished.length || reportCompleted) {
    chosenAction = "finish_run";
    reason = "所有必需任务已完成，允许物化并结束本次运行。";
  } else if (canAppend) {
    chosenAction = "append_task";
    reason = `公开证据覆盖不足（${urls.length}/${minSources} 个来源，${domains.length}/${minDomains} 个域名），追加一次受控补充研究。`;
  } else if (expansionCheckpoint && coverageScore < 1 && (budgetExhausted || dynamicTaskCount >= maxDynamicTasks)) {
    chosenAction = "stop_expansion";
    reason = budgetExhausted
      ? "Token 预算已耗尽，停止动态扩展，但继续执行固定必需任务。"
      : "动态任务数量已达到策略上限，停止扩展并继续固定 DAG。";
  }

  const candidates: ReasoningCandidate[] = [
    { actionType: "continue", score: chosenAction === "continue" ? 1 : 0.35, allowed: true, selected: chosenAction === "continue", payload: {}, rejectionReasons: [] },
    { actionType: "append_task", score: canAppend ? 1 : 0, allowed: canAppend, selected: chosenAction === "append_task", payload: appendPayload, rejectionReasons: appendRejections },
    { actionType: "stop_expansion", score: chosenAction === "stop_expansion" ? 1 : 0.25, allowed: true, selected: chosenAction === "stop_expansion", payload: { preservesRequiredTasks: true }, rejectionReasons: [] },
    { actionType: "finish_run", score: chosenAction === "finish_run" ? 1 : 0, allowed: !unfinished.length || reportCompleted, selected: chosenAction === "finish_run", payload: {}, rejectionReasons: unfinished.length && !reportCompleted ? ["required_tasks_incomplete"] : [] },
  ];
  const sequenceResult = await queryable.query<{ value: number }>(
    "select coalesce(max(sequence), -1)::int + 1 as value from reasoning_decisions where run_id = $1",
    [input.runId],
  );
  const publicId = createPublicId("rsn");
  const decision = await queryable.query<{ id: string }>(
    `insert into reasoning_decisions (
       public_id, workspace_id, study_id, run_id, decision_key, sequence, trigger_type,
       policy_version, input_snapshot, artifact_refs, evidence_refs, budget_snapshot,
       metrics, chosen_action, reason
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
               $12::jsonb, $13::jsonb, $14::jsonb, $15)
     returning id::text as id`,
    [
      publicId, input.workspaceId, input.studyId, input.runId, decisionKey, sequenceResult.rows[0].value,
      input.triggerType ?? "checkpoint", REASONING_POLICY_VERSION,
      JSON.stringify({ completedTaskKeys: completedKeys, unfinishedTaskKeys: unfinished.map((task) => task.key) }),
      JSON.stringify(artifacts.rows.map((artifact) => ({ publicId: artifact.public_id, taskKey: artifact.task_key, artifactType: artifact.artifact_type }))),
      JSON.stringify(urls),
      JSON.stringify({ tokenBudget: configuredBudget, tokenUsage, tokenRemaining: budgetRemaining, elapsedMs: input.elapsedMs ?? 0, maxDynamicTasks, dynamicTaskCount }),
      JSON.stringify({ coverage: coverageScore, conflict: conflictScore, novelty: noveltyScore, sourceCount: urls.length, domainCount: domains.length }),
      JSON.stringify({ type: chosenAction }), reason,
    ],
  );
  for (const [position, candidate] of candidates.entries()) {
    await queryable.query(
      `insert into reasoning_decision_candidates (
         decision_id, position, action_type, score, allowed, selected, payload, rejection_reasons
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
      [decision.rows[0].id, position, candidate.actionType, candidate.score, candidate.allowed, candidate.selected, JSON.stringify(candidate.payload), JSON.stringify(candidate.rejectionReasons)],
    );
  }

  let appendedTaskKey: string | null = null;
  if (chosenAction === "append_task" && gate) {
    appendedTaskKey = `research_dynamic_${dynamicTaskCount + 1}`;
    const generation = Math.max(0, ...tasks.map((task) => task.generation)) + 1;
    await queryable.query(
      "update study_tasks set position = position + 10000 where run_id = $1 and position >= $2",
      [input.runId, gate.position],
    );
    await queryable.query(
      "update study_tasks set position = position - 9999 where run_id = $1 and position >= $2",
      [input.runId, gate.position + 10000],
    );
    await queryable.query(
      `insert into study_tasks (
         public_id, study_id, run_id, position, task_key, title, tool_name, depends_on,
         input, timeout_seconds, origin, generation, reasoning_decision_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 300, 'dynamic', $10, $11)`,
      [
        createPublicId("tsk"), input.studyId, input.runId, gate.position, appendedTaskKey,
        "补充研究：扩大来源与约束覆盖", appendPayload.toolName,
        JSON.stringify(completedResearch.map((task) => task.key)),
        JSON.stringify({ focus: `补足公开证据覆盖：新增至少 ${appendPayload.gaps.sources} 个来源和 ${appendPayload.gaps.domains} 个独立域名，优先寻找反例、限制条件和一手资料。` }),
        generation, decision.rows[0].id,
      ],
    );
    await queryable.query(
      `update study_tasks
       set depends_on = case when depends_on ? $3 then depends_on else depends_on || to_jsonb($3::text) end,
           updated_at = now()
       where run_id = $1 and task_key = $2`,
      [input.runId, gate.key, appendedTaskKey],
    );
    await queryable.query(
      `update reasoning_decisions set chosen_action = $2::jsonb where id = $1`,
      [decision.rows[0].id, JSON.stringify({ type: chosenAction, taskKey: appendedTaskKey, template: appendPayload.template })],
    );
    await queryable.query(
      `update study_runs set dynamic_task_count = dynamic_task_count + 1,
              reasoning_policy_version = $2, expansion_stop_reason = null
       where id = $1`,
      [input.runId, REASONING_POLICY_VERSION],
    );
  } else if (chosenAction === "stop_expansion") {
    await queryable.query(
      `update study_runs set reasoning_policy_version = $2, expansion_stop_reason = $3 where id = $1`,
      [input.runId, REASONING_POLICY_VERSION, reason],
    );
  } else {
    await queryable.query(
      "update study_runs set reasoning_policy_version = $2 where id = $1",
      [input.runId, REASONING_POLICY_VERSION],
    );
  }
  await queryable.query(
    `insert into study_events (study_id, run_id, event_type, payload)
     values ($1, $2, 'reasoning.decision.recorded', $3::jsonb)`,
    [input.studyId, input.runId, JSON.stringify({ decisionPublicId: publicId, decisionKey, chosenAction, appendedTaskKey, policyVersion: REASONING_POLICY_VERSION, reason })],
  );
  return {
    publicId,
    decisionKey,
    sequence: sequenceResult.rows[0].value,
    chosenAction,
    reason,
    appendedTaskKey,
    reused: false,
  };
}
