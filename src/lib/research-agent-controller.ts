import { isDeepStrictEqual } from "node:util";
import type { Queryable } from "@/lib/db";
import {
  streamProviderResearchAgentDecision,
  type ProviderResearchAgentDecision,
  type ProviderResearchAgentStreamEvent,
} from "@/lib/openai-provider";
import {
  RESEARCH_AGENT_CONTROLLER_VERSION,
  type AgentAction,
} from "@/lib/research-agent-contract";
import { validateResearchAgentTaskTemplate } from "@/lib/research-agent-templates";

export type ResearchAgentControllerMode = "off" | "shadow" | "active";

export type ResearchAgentRollout = {
  requestedMode: ResearchAgentControllerMode;
  effectiveMode: ResearchAgentControllerMode;
  reason: string;
  sampleCount: number;
};

export type ResearchAgentTaskSnapshot = {
  key: string;
  title: string;
  toolName: string;
  status: string;
  dependsOn: string[];
  input: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
};

export function summarizeResearchAgentTaskResult(output: unknown) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  const sources = Array.isArray(record.sources) ? record.sources : [];
  const sourcePreview = sources.slice(0, 8).flatMap((source) => {
    if (!source || typeof source !== "object") return [];
    const item = source as Record<string, unknown>;
    const url = typeof item.url === "string" ? item.url : null;
    const title = typeof item.title === "string" ? item.title.slice(0, 160) : null;
    return url || title ? [{ title, url }] : [];
  });
  const audit = record.audit && typeof record.audit === "object" && !Array.isArray(record.audit)
    ? record.audit as Record<string, unknown>
    : null;
  const directions = Array.isArray(record.directions) ? record.directions.slice(0, 8).flatMap((direction) => {
    if (!direction || typeof direction !== "object") return [];
    const item = direction as Record<string, unknown>;
    return typeof item.title === "string" ? [{ title: item.title.slice(0, 160), verdict: item.verdict ?? null }] : [];
  }) : [];
  const summary = typeof record.summary === "string" ? record.summary.slice(0, 800) : null;
  const result: Record<string, unknown> = {};
  if (sources.length) result.sourceCount = sources.length;
  if (sourcePreview.length) result.sources = sourcePreview;
  if (audit) {
    result.connector = {
      status: audit.status ?? null,
      collectedCount: audit.collectedCount ?? null,
      rejectedCount: audit.rejectedCount ?? null,
      unavailableCount: audit.unavailableCount ?? null,
    };
  }
  if (summary) result.summary = summary;
  if (directions.length) result.directions = directions;
  return Object.keys(result).length ? result : undefined;
}

export type ResearchAgentDecisionInput = {
  study: {
    studyId: string;
    runId: string;
    publicId: string;
    userPublicId: string;
    brief: string;
    studyType: string;
    framework: string;
    methods: string[];
    audience: string;
  };
  tasks: ResearchAgentTaskSnapshot[];
  completedStateKeys: string[];
  contextSummary?: string;
  availableToolNames?: readonly string[];
  allowedTaskTemplates?: readonly string[];
  maxDynamicTasks?: number;
};

export function getResearchAgentControllerMode(config?: Record<string, unknown>): ResearchAgentControllerMode {
  const configured = typeof config?.agentControllerMode === "string"
    ? config.agentControllerMode
    : process.env.RESEARCH_AGENT_CONTROLLER_MODE;
  return configured === "active" || configured === "shadow" ? configured : "off";
}

export function isResearchAgentControllerEnabled(mode: ResearchAgentControllerMode) {
  return mode !== "off";
}

function boundedNumber(config: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(config[key] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

export function assessResearchAgentRolloutQuality(input: {
  metrics: Array<Record<string, unknown>>;
  strategyConfig?: Record<string, unknown>;
}) {
  const config = input.strategyConfig ?? {};
  const maxFailureRate = boundedNumber(config, "agentControllerMaxFailureRate", 0.1, 0, 1);
  const maxRejectRate = boundedNumber(config, "agentControllerMaxRejectRate", 0.6, 0, 1);
  const minCallToolMatchRate = boundedNumber(config, "agentControllerMinCallToolMatchRate", 0.8, 0, 1);
  const minTemplateMatchRate = boundedNumber(config, "agentControllerMinTemplateMatchRate", 0.8, 0, 1);
  if (!input.metrics.length) return { passed: false as const, reason: "shadow_sample_insufficient" };
  const failureRate = input.metrics.reduce((sum, item) => sum + Number(item.controllerFailureRate ?? 1), 0) / input.metrics.length;
  const rejectRate = input.metrics.reduce((sum, item) => sum + Number(item.policyRejectRate ?? 1), 0) / input.metrics.length;
  const matchRate = input.metrics.reduce((sum, item) => sum + Number(item.callToolMatchRate ?? 0), 0) / input.metrics.length;
  const templateMatchRate = input.metrics.reduce((sum, item) => {
    const shadowIgnored = item.controllerMode === "shadow" && Number(item.shadowIgnoredCount ?? 0) > 0;
    return sum + (shadowIgnored ? 1 : Number(item.templateMatchRate ?? 1));
  }, 0) / input.metrics.length;
  const reportGateFailures = input.metrics.filter((item) => item.reportGatePassed !== true).length;
  if (failureRate > maxFailureRate) return { passed: false as const, reason: "shadow_failure_rate_exceeded" };
  if (rejectRate > maxRejectRate) return { passed: false as const, reason: "shadow_policy_reject_rate_exceeded" };
  if (matchRate < minCallToolMatchRate) return { passed: false as const, reason: "shadow_tool_match_rate_below_threshold" };
  if (templateMatchRate < minTemplateMatchRate) return { passed: false as const, reason: "shadow_template_match_rate_below_threshold" };
  if (reportGateFailures > 0) return { passed: false as const, reason: "shadow_report_gate_failed" };
  return { passed: true as const, reason: "shadow_quality_gate_passed" };
}

export async function resolveResearchAgentRollout(input: {
  queryable: Queryable;
  workspaceId: string;
  strategyKey: string;
  strategyConfig?: Record<string, unknown>;
}): Promise<ResearchAgentRollout> {
  const config = input.strategyConfig ?? {};
  const requestedMode = getResearchAgentControllerMode(config);
  if (requestedMode !== "active") {
    return { requestedMode, effectiveMode: requestedMode, reason: requestedMode === "shadow" ? "strategy_shadow" : "strategy_off", sampleCount: 0 };
  }
  const minRuns = Math.round(boundedNumber(config, "agentControllerShadowMinRuns", 3, 1, 20));
  const recent = await input.queryable.query<{
    controller_mode: "off" | "shadow" | "active";
    metrics: Record<string, unknown> | string;
  }>(
    `select evaluation.controller_mode, evaluation.metrics
     from research_agent_trajectory_evaluations evaluation
     join study_runs run on run.id = evaluation.run_id
     where evaluation.workspace_id = $1 and run.strategy_key = $2
       and evaluation.evaluator_version = 'research-agent-trajectory-v1'
       and evaluation.metrics->>'executionSource' = 'worker'
       and evaluation.controller_mode = 'shadow'
     order by evaluation.created_at desc, evaluation.id desc
     limit $3`,
    [input.workspaceId, input.strategyKey, minRuns],
  );
  if (recent.rows.length < minRuns) {
    return { requestedMode, effectiveMode: "shadow", reason: "shadow_sample_insufficient", sampleCount: recent.rows.length };
  }
  const metrics = recent.rows.map((row) => ({
    ...(typeof row.metrics === "string" ? JSON.parse(row.metrics) as Record<string, unknown> : row.metrics),
    controllerMode: row.controller_mode,
  }));
  const quality = assessResearchAgentRolloutQuality({ metrics, strategyConfig: config });
  if (!quality.passed) return { requestedMode, effectiveMode: "shadow", reason: quality.reason, sampleCount: metrics.length };
  return { requestedMode, effectiveMode: "active", reason: quality.reason, sampleCount: metrics.length };
}

export function validateResearchAgentAction(input: {
  action: AgentAction;
  tasks: ResearchAgentTaskSnapshot[];
  completedStateKeys: string[];
  availableToolNames?: readonly string[];
  allowedTaskTemplates?: readonly string[];
  maxDynamicTasks?: number;
}) {
  const ready = input.tasks.filter((task) => (
    task.status === "pending" && task.dependsOn.every((dependency) => input.completedStateKeys.includes(dependency))
  ));
  if (input.action.type === "call_tool" && "taskKey" in input.action && "toolName" in input.action) {
    const action = input.action as Extract<AgentAction, { type: "call_tool" }>;
    const task = ready.find((candidate) => candidate.key === action.taskKey);
    if (!task) return { accepted: false as const, reason: "task_not_ready", task: null };
    if (task.toolName !== action.toolName) {
      return { accepted: false as const, reason: "tool_mismatch", task: null };
    }
    if (!isDeepStrictEqual(task.input, action.arguments)) {
      return { accepted: false as const, reason: "arguments_mismatch", task: null };
    }
    return { accepted: true as const, reason: null, task };
  }
  if (input.action.type === "replan") {
    const requested = input.action.requestedTasks;
    const availableTools = input.availableToolNames ? new Set(input.availableToolNames) : null;
    const existingKeys = new Set(input.tasks.map((task) => task.key));
    const requestedKeys = new Set<string>();
    const maxDynamicTasks = Math.max(0, Math.min(8, input.maxDynamicTasks ?? 2));
    if (!requested.length) return { accepted: false as const, reason: "replan_requires_tasks", task: null };
    if (!input.tasks.some((task) => task.toolName === "generateReport" && task.status === "pending")) {
      return { accepted: false as const, reason: "report_gate_not_open", task: null };
    }
    if (requested.length > maxDynamicTasks) {
      return { accepted: false as const, reason: "dynamic_task_limit_exceeded", task: null };
    }
    for (const candidate of requested) {
      if (existingKeys.has(candidate.key) || requestedKeys.has(candidate.key)) {
        return { accepted: false as const, reason: "task_key_conflict", task: null };
      }
      if (availableTools && !availableTools.has(candidate.toolName)) {
        return { accepted: false as const, reason: "tool_not_allowed", task: null };
      }
      const templateValidation = validateResearchAgentTaskTemplate({
        template: candidate.template,
        toolName: candidate.toolName,
        taskInput: candidate.input,
        allowedTemplates: input.allowedTaskTemplates,
      });
      if (!templateValidation.accepted) {
        return { accepted: false as const, reason: templateValidation.reason, task: null };
      }
      for (const dependency of candidate.dependsOn) {
        if (dependency === candidate.key || (!existingKeys.has(dependency) && !requestedKeys.has(dependency))) {
          return { accepted: false as const, reason: "dependency_unknown", task: null };
        }
        const existingDependency = input.tasks.find((task) => task.key === dependency);
        if (existingDependency && !["completed", "skipped"].includes(existingDependency.status)) {
          return { accepted: false as const, reason: "dependency_not_completed", task: null };
        }
      }
      requestedKeys.add(candidate.key);
    }
    return { accepted: true as const, reason: null, task: null };
  }
  if (input.action.type === "ask_user") {
    const action = input.action;
    const availableTools = input.availableToolNames ? new Set(input.availableToolNames) : null;
    const task = ready.find((candidate) => (
      candidate.key === action.taskKey
      && (!availableTools || availableTools.has(candidate.toolName))
    ));
    if (!task) return { accepted: false as const, reason: "no_ready_task_for_input", task: null };
    if (!action.fields.length) return { accepted: false as const, reason: "input_fields_required", task: null };
    if (new Set(action.fields.map((field) => field.key)).size !== action.fields.length) {
      return { accepted: false as const, reason: "input_field_conflict", task: null };
    }
    const supportedFields = new Set(["focus", "sourceUrls", "selectedOption"]);
    if (action.fields.some((field) => !supportedFields.has(field.key))) {
      return { accepted: false as const, reason: "input_field_not_supported", task: null };
    }
    if (action.fields.some((field) => (
      (field.key === "focus" && field.type !== "text")
      || (field.key === "sourceUrls" && field.type !== "url_list")
      || (field.key === "selectedOption" && field.type !== "choice")
    ))) return { accepted: false as const, reason: "input_field_type_mismatch", task: null };
    return { accepted: true as const, reason: null, task };
  }
  if (input.action.type === "finish") {
    const incomplete = input.tasks.some((task) => !["completed", "skipped"].includes(task.status));
    if (incomplete) return { accepted: false as const, reason: "required_tasks_incomplete", task: null };
    return { accepted: true as const, reason: null, task: null };
  }
  return { accepted: false as const, reason: "action_not_supported", task: null };
}

async function writeControllerEvent(
  queryable: Queryable | undefined,
  input: ResearchAgentDecisionInput,
  type: string,
  payload: Record<string, unknown>,
) {
  if (!queryable) return;
  await queryable.query(
    `insert into study_events (study_id, run_id, event_type, payload)
     values ($1, $2, $3, $4::jsonb)`,
    [input.study.studyId, input.study.runId, type, JSON.stringify(payload)],
  );
}

export async function decideResearchAgentAction(
  input: ResearchAgentDecisionInput,
  options: { queryable?: Queryable } = {},
): Promise<ProviderResearchAgentDecision> {
  const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await writeControllerEvent(options.queryable, input, "agent.turn.started", {
    controllerVersion: RESEARCH_AGENT_CONTROLLER_VERSION,
    turnId,
    readyTaskKeys: input.tasks
      .filter((task) => task.status === "pending" && task.dependsOn.every((dependency) => input.completedStateKeys.includes(dependency)))
      .map((task) => task.key),
    allowedTaskTemplates: input.allowedTaskTemplates ?? null,
  });
  let summary = "";
  let result: ProviderResearchAgentDecision;
  try {
    result = await streamProviderResearchAgentDecision({
    brief: input.study.brief,
    studyType: input.study.studyType,
    framework: input.study.framework,
    methods: input.study.methods,
    audience: input.study.audience,
    tasks: input.tasks,
    completedStateKeys: input.completedStateKeys,
    contextSummary: input.contextSummary,
    availableToolNames: input.availableToolNames,
    allowedTaskTemplates: input.allowedTaskTemplates,
    maxDynamicTasks: input.maxDynamicTasks,
    userPublicId: input.study.userPublicId,
    onEvent: async (event: ProviderResearchAgentStreamEvent) => {
      if (event.type === "decision.summary.delta") {
        summary = `${summary}${event.delta}`.slice(-2000);
      } else if (event.type === "provider.non_streaming") {
        await writeControllerEvent(options.queryable, input, "agent.provider.non_streaming", { turnId });
      }
    },
    });
  } catch (error) {
    const fallbackTask = input.tasks.find((task) => (
      task.status === "pending" && task.dependsOn.every((dependency) => input.completedStateKeys.includes(dependency))
    ));
    if (!fallbackTask) throw error;
    result = {
      action: {
        type: "call_tool",
        summary: "Controller 输出未通过动作协议，回退到当前就绪任务。",
        taskKey: fallbackTask.key,
        toolName: fallbackTask.toolName,
        arguments: fallbackTask.input,
      },
      responseId: "controller-protocol-repair",
      model: "deterministic-fallback",
      promptVersion: RESEARCH_AGENT_CONTROLLER_VERSION,
      usage: null,
    };
    await writeControllerEvent(options.queryable, input, "agent.controller.repaired", {
      turnId,
      reason: error instanceof Error ? error.message.slice(0, 300) : "provider_action_invalid",
      fallbackTaskKey: fallbackTask.key,
    });
  }
  const validation = validateResearchAgentAction({
    action: result.action,
    tasks: input.tasks,
    completedStateKeys: input.completedStateKeys,
    availableToolNames: input.availableToolNames,
    allowedTaskTemplates: input.allowedTaskTemplates,
    maxDynamicTasks: input.maxDynamicTasks,
  });
  await writeControllerEvent(options.queryable, input, "agent.action.proposed", {
    turnId,
    action: result.action,
    decisionSummary: summary || result.action.summary,
    responseId: result.responseId,
    model: result.model,
    promptVersion: result.promptVersion,
  });
  // Only persist the validated, user-safe summary. Provider output deltas are
  // structured JSON fragments and must not be rendered as hidden reasoning.
  await writeControllerEvent(options.queryable, input, "agent.decision.summary.delta", {
    turnId,
    delta: result.action.summary,
  });
  if (!validation.accepted) {
    await writeControllerEvent(options.queryable, input, "agent.action.rejected", {
      turnId,
      reason: validation.reason,
      action: result.action,
    });
  }
  await writeControllerEvent(options.queryable, input, "agent.turn.completed", {
    turnId,
    accepted: validation.accepted,
    selectedTaskKey: validation.task?.key ?? null,
    responseId: result.responseId,
    model: result.model,
  });
  return result;
}
