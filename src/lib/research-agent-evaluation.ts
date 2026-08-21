import { createPublicId } from "@/lib/identifiers";
import type { Queryable } from "@/lib/db";

export const RESEARCH_AGENT_TRAJECTORY_EVALUATOR_VERSION = "research-agent-trajectory-v1";

type JsonValue = Record<string, unknown> | string | null;
type EventRow = { id: string; event_type: string; payload: JsonValue; created_at: string };

export type ResearchAgentTrajectoryMetrics = {
  executionSource: "worker" | "local_harness_probe";
  runStatus: string;
  decisionCount: number;
  controllerTurnCount: number;
  controllerFailureCount: number;
  controllerFailureRate: number;
  policyRejectCount: number;
  policyRejectRate: number;
  shadowIgnoredCount: number;
  callToolProposalCount: number;
  callToolMatchedCount: number;
  callToolMatchRate: number;
  templateProposalCount: number;
  templateAcceptedCount: number;
  templateMatchRate: number;
  replanAcceptedCount: number;
  dynamicTaskCount: number;
  sourceCount: number;
  distinctDomainCount: number;
  evidenceGain: number;
  totalTokens: number;
  durationMs: number | null;
  decisionLatencyMs: number | null;
  retryCount: number;
  recoveryEventCount: number;
  humanInterventionCount: number;
  reportGatePassed: boolean;
};

export type ResearchAgentTrajectoryEvaluation = {
  publicId: string;
  workspaceId: string;
  studyId: string;
  runId: string;
  evaluatorVersion: string;
  controllerMode: "off" | "shadow" | "active";
  metrics: ResearchAgentTrajectoryMetrics;
};

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function totalTokens(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  if ("total_tokens" in value && typeof value.total_tokens === "number") return value.total_tokens;
  if ("totalTokens" in value && typeof value.totalTokens === "number") return value.totalTokens;
  return 0;
}

function payloadObject(value: JsonValue): Record<string, unknown> {
  const parsed = value === null ? {} : parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function eventTaskKeys(event: EventRow) {
  const payload = payloadObject(event.payload);
  return Array.isArray(payload.taskKeys) ? payload.taskKeys.filter((key): key is string => typeof key === "string") : [];
}

function actionPayload(event: EventRow) {
  const payload = payloadObject(event.payload);
  return payload.action && typeof payload.action === "object" ? payload.action as Record<string, unknown> : {};
}

function requestedTemplateCount(event: EventRow) {
  const action = actionPayload(event);
  if (action.type !== "replan" || !Array.isArray(action.requestedTasks)) return 0;
  return action.requestedTasks.filter((task) => task && typeof task === "object" && typeof (task as Record<string, unknown>).template === "string").length;
}

function acceptedTemplateCount(event: EventRow) {
  const payload = payloadObject(event.payload);
  return Array.isArray(payload.templates)
    ? payload.templates.filter((template) => template && typeof template === "object" && typeof (template as Record<string, unknown>).template === "string").length
    : 0;
}

function sourceUrls(value: JsonValue) {
  const output = payloadObject(value);
  return Array.isArray(output.sources)
    ? output.sources.flatMap((source) => source && typeof source === "object" && "url" in source && typeof source.url === "string" ? [source.url] : [])
    : [];
}

function domain(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export async function evaluateResearchAgentTrajectory(queryable: Queryable, input: {
  workspaceId: string;
  studyId: string;
  runId: string;
  controllerMode?: "off" | "shadow" | "active";
  executionSource?: "worker" | "local_harness_probe";
  evaluatorVersion?: string;
}): Promise<ResearchAgentTrajectoryEvaluation> {
  const evaluatorVersion = input.evaluatorVersion ?? RESEARCH_AGENT_TRAJECTORY_EVALUATOR_VERSION;
  const [runResult, eventsResult, tasksResult] = await Promise.all([
    queryable.query<{
      status: string; usage: JsonValue; started_at: string | null; finished_at: string | null;
    }>("select status, usage, started_at::text as started_at, finished_at::text as finished_at from study_runs where id = $1 and study_id = $2", [input.runId, input.studyId]),
    queryable.query<EventRow>("select id::text as id, event_type, payload, created_at::text as created_at from study_events where run_id = $1 order by created_at, id", [input.runId]),
    queryable.query<{ status: string; origin: string; attempt: number; tool_name: string; output: JsonValue }>("select status, origin, attempt, tool_name, output from study_tasks where run_id = $1 order by position, id", [input.runId]),
  ]);
  const run = runResult.rows[0];
  if (!run) throw new Error("RESEARCH_AGENT_TRAJECTORY_RUN_NOT_FOUND");
  const events = eventsResult.rows;
  const proposals = events.filter((event) => event.event_type === "agent.action.proposed");
  const rejects = events.filter((event) => event.event_type === "agent.action.rejected");
  const turns = events.filter((event) => event.event_type === "agent.turn.started");
  const failures = events.filter((event) => event.event_type === "agent.controller.failed");
  const shadowIgnored = events.filter((event) => event.event_type === "agent.action.shadow_ignored");
  const replans = events.filter((event) => event.event_type === "agent.replan.accepted");
  const waves = events.filter((event) => event.event_type === "dag.wave.started");
  const callToolProposals = proposals.filter((event) => actionPayload(event).type === "call_tool");
  const callToolMatched = callToolProposals.filter((proposal) => {
    const action = actionPayload(proposal);
    const taskKey = typeof action.taskKey === "string" ? action.taskKey : null;
    return Boolean(taskKey && waves.some((wave) => (
      new Date(wave.created_at).getTime() >= new Date(proposal.created_at).getTime()
      && eventTaskKeys(wave).includes(taskKey)
    )));
  }).length;
  const templateProposalCount = proposals.reduce((sum, proposal) => sum + requestedTemplateCount(proposal), 0);
  const templateAcceptedCount = replans.reduce((sum, accepted) => sum + acceptedTemplateCount(accepted), 0);
  const decisionLatencies = turns.flatMap((turn) => {
    const turnId = payloadObject(turn.payload).turnId;
    const completed = events.find((event) => event.event_type === "agent.turn.completed" && payloadObject(event.payload).turnId === turnId && event.id > turn.id);
    return completed ? [Math.max(0, new Date(completed.created_at).getTime() - new Date(turn.created_at).getTime())] : [];
  });
  const urls = [...new Set(tasksResult.rows.flatMap((task) => sourceUrls(task.output)))];
  const domains = new Set(urls.map(domain).filter(Boolean));
  const reportGatePassed = tasksResult.rows.some((task) => task.tool_name === "finalizeReport" && ["completed", "skipped"].includes(task.status))
    || tasksResult.rows.some((task) => task.tool_name === "generateReport" && task.status === "completed");
  const started = run.started_at ? new Date(run.started_at).getTime() : null;
  const finished = run.finished_at ? new Date(run.finished_at).getTime() : null;
  const durationMs = started !== null && finished !== null ? Math.max(0, finished - started) : null;
  const metrics: ResearchAgentTrajectoryMetrics = {
    executionSource: input.executionSource ?? "local_harness_probe",
    runStatus: run.status,
    decisionCount: proposals.length,
    controllerTurnCount: turns.length,
    controllerFailureCount: failures.length,
    controllerFailureRate: turns.length ? failures.length / turns.length : 0,
    policyRejectCount: rejects.length,
    policyRejectRate: proposals.length ? rejects.length / proposals.length : 0,
    shadowIgnoredCount: shadowIgnored.length,
    callToolProposalCount: callToolProposals.length,
    callToolMatchedCount: callToolMatched,
    callToolMatchRate: callToolProposals.length ? callToolMatched / callToolProposals.length : 0,
    templateProposalCount,
    templateAcceptedCount,
    templateMatchRate: templateProposalCount ? templateAcceptedCount / templateProposalCount : 1,
    replanAcceptedCount: replans.length,
    dynamicTaskCount: tasksResult.rows.filter((task) => task.origin === "dynamic").length,
    sourceCount: urls.length,
    distinctDomainCount: domains.size,
    evidenceGain: urls.length,
    totalTokens: totalTokens(parseJson(run.usage)),
    durationMs,
    decisionLatencyMs: decisionLatencies.length ? decisionLatencies.reduce((sum, value) => sum + value, 0) / decisionLatencies.length : null,
    retryCount: tasksResult.rows.reduce((sum, task) => sum + Math.max(0, task.attempt - 1), 0),
    recoveryEventCount: events.filter((event) => event.event_type === "run.tasks.recovered").length,
    humanInterventionCount: events.filter((event) => event.event_type === "agent.run.waiting_input").length,
    reportGatePassed,
  };
  const controllerMode = input.controllerMode ?? (turns.length ? "shadow" : "off");
  const persisted = await queryable.query<{ public_id: string }>(
    `insert into research_agent_trajectory_evaluations
       (public_id, workspace_id, study_id, run_id, evaluator_version, controller_mode, metrics)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (run_id, evaluator_version) do update set
       controller_mode = excluded.controller_mode, metrics = excluded.metrics, created_at = now()
     returning public_id`,
    [createPublicId("rae"), input.workspaceId, input.studyId, input.runId, evaluatorVersion, controllerMode, JSON.stringify(metrics)],
  );
  return { publicId: persisted.rows[0].public_id, workspaceId: input.workspaceId, studyId: input.studyId, runId: input.runId, evaluatorVersion, controllerMode, metrics };
}
