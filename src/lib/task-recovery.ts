import { createPublicId } from "@/lib/identifiers";
import { type Queryable } from "@/lib/db";
import { describeOpenAIError } from "@/lib/openai-provider";
import { hashJson } from "@/lib/skill-executor";

export type TaskFailureClass = "cancelled" | "timeout" | "rate_limited" | "upstream" | "response" | "input_required" | "configuration" | "validation" | "unknown";
export type TaskFailureDisposition = "retry" | "waiting_input" | "terminal" | "cancelled";

export type TaskFailure = {
  className: TaskFailureClass;
  code: string | null;
  message: string;
  retryable: boolean;
  disposition: TaskFailureDisposition;
  inputRequest?: Record<string, unknown>;
};

export class RuntimeInputRequired extends Error {
  readonly request: Record<string, unknown>;

  constructor(message: string, request: Record<string, unknown> = {}) {
    super(message);
    this.name = "RuntimeInputRequired";
    this.request = request;
  }
}

export class TaskTerminalFailure extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = "TaskTerminalFailure";
    this.code = code;
  }
}

function messageIncludes(error: unknown, ...needles: string[]) {
  const message = error instanceof Error ? error.message : "";
  return needles.some((needle) => message.includes(needle));
}

export function classifyTaskError(error: unknown): TaskFailure {
  if (error instanceof RuntimeInputRequired) {
    return {
      className: "input_required",
      code: "RUNTIME_INPUT_REQUIRED",
      message: error.message,
      retryable: false,
      disposition: "waiting_input",
      inputRequest: error.request,
    };
  }
  if (error instanceof TaskTerminalFailure) {
    return { className: "validation", code: error.code, message: error.message, retryable: false, disposition: "terminal" };
  }

  const described = describeOpenAIError(error);
  if (described.code === "RUNTIME_ABORTED" || messageIncludes(error, "RUNTIME_CANCELLED")) {
    return { className: "cancelled", code: described.code, message: described.message, retryable: false, disposition: "cancelled" };
  }
  if (described.code === "RUNTIME_TIMEOUT" || described.code === "UPSTREAM_TIMEOUT") {
    return { className: "timeout", code: described.code, message: described.message, retryable: true, disposition: "retry" };
  }
  if (described.code === "RUNTIME_RATE_LIMITED" || described.status === 429) {
    return { className: "rate_limited", code: described.code, message: described.message, retryable: true, disposition: "retry" };
  }
  if (described.code === "PUBLIC_WEB_SOURCES_INSUFFICIENT") {
    return {
      className: "input_required",
      code: described.code,
      message: described.message,
      retryable: false,
      disposition: "waiting_input",
      inputRequest: {
        title: "补充公开研究范围",
        description: "当前可核查的公开网页来源不足。请补充具体研究焦点或 1 至 8 个可公开访问的可信 URL。",
        fields: [
          { key: "focus", label: "补充研究焦点", type: "text", required: false, maxLength: 600 },
          { key: "sourceUrls", label: "可信公开 URL", type: "url_list", required: false, maxItems: 8 },
        ],
      },
    };
  }
  if (
    described.code === "OPENAI_API_KEY_MISSING"
    || messageIncludes(
      error,
      "API_KEY_MISSING", "UNSAFE", "FORBIDDEN", "SKILL_DISABLED",
      "SKILL_BINDING_MISSING", "SKILL_VERSION_UNAVAILABLE", "SKILL_EXECUTOR_", "SKILL_MCP_",
    )
  ) {
    return { className: "configuration", code: described.code, message: described.message, retryable: false, disposition: "terminal" };
  }
  if (
    described.status === 408 || described.status === 409 || described.status === 425
    || (typeof described.status === "number" && described.status >= 500)
    || messageIncludes(
      error,
      "APIConnection", "ECONN", "ETIMEDOUT", "OPENAI_INVALID_JSON",
      "OPENAI_INVALID_SCHEMA", "UPSTREAM_INCOMPATIBLE_RESPONSE",
    )
  ) {
    return { className: described.status && described.status >= 500 ? "upstream" : "response", code: described.code, message: described.message, retryable: true, disposition: "retry" };
  }
  if (messageIncludes(error, "ZodError", "HARNESS_STATE_MISSING", "VALIDATION", "INVALID")) {
    return { className: "validation", code: described.code, message: described.message, retryable: false, disposition: "terminal" };
  }
  return { className: "unknown", code: described.code, message: described.message, retryable: false, disposition: "terminal" };
}

export function taskRetryDelaySeconds(attempt: number) {
  return Math.min(60, Math.max(2, 2 ** Math.max(0, attempt - 1)));
}

export type StartedTaskAttempt = {
  invocationId: string;
  invocationPublicId: string;
  attempt: number;
};

export async function startTaskAttempt(queryable: Queryable, input: {
  studyId: string;
  runId: string;
  taskId: string;
  taskKey: string;
  toolName: string;
  skillVersion: number;
  skillBindingId?: string | null;
  executorType?: "builtin" | "declarative_http" | "mcp" | "sandbox";
  contextRetrievalId: string | null;
  arguments: Record<string, unknown>;
}) : Promise<StartedTaskAttempt> {
  const task = await queryable.query<{ attempt: number }>(
    `update study_tasks set status = 'running', attempt = attempt + 1, next_attempt_at = null,
            error_message = null, waiting_reason = null, waiting_payload = null, waiting_since = null,
            started_at = now(), finished_at = null, updated_at = now()
     where id = $1 and status = 'pending' and (next_attempt_at is null or next_attempt_at <= now())
     returning attempt`,
    [input.taskId],
  );
  const attempt = task.rows[0]?.attempt;
  if (!attempt) throw new Error("TASK_ATTEMPT_NOT_READY");

  const invocation = await queryable.query<{ id: string; public_id: string }>(
    `insert into study_tool_invocations (
       public_id, study_id, run_id, task_id, tool_name, idempotency_key, arguments,
       skill_slug, skill_version, context_retrieval_id, skill_binding_id, executor_type, request_hash
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $5, $8, $9, $10, $11, $12)
     on conflict (idempotency_key) do update set
       status = 'running', arguments = excluded.arguments, error_message = null,
       skill_slug = excluded.skill_slug, skill_version = excluded.skill_version,
       context_retrieval_id = excluded.context_retrieval_id,
       skill_binding_id = excluded.skill_binding_id, executor_type = excluded.executor_type,
       request_hash = excluded.request_hash, response_hash = null,
       attempt = study_tool_invocations.attempt + 1, started_at = now(), finished_at = null
     returning id::text as id, public_id`,
    [
      createPublicId("inv"), input.studyId, input.runId, input.taskId, input.toolName,
      `${input.runId}:${input.taskKey}`, JSON.stringify(input.arguments), input.skillVersion, input.contextRetrievalId,
      input.skillBindingId ?? null, input.executorType ?? "builtin", hashJson(input.arguments),
    ],
  );
  const row = invocation.rows[0];
  await queryable.query(
    `insert into study_task_attempts (
       public_id, study_id, run_id, task_id, invocation_id, attempt, status, metadata
     ) values ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb)
     on conflict (task_id, attempt) do update set
       invocation_id = excluded.invocation_id, status = 'running', error_class = null, error_code = null,
       error_message = null, retryable = null, finished_at = null, metadata = excluded.metadata`,
    [
      createPublicId("tat"), input.studyId, input.runId, input.taskId, row.id, attempt,
      JSON.stringify({
        toolName: input.toolName,
        skillVersion: input.skillVersion,
        skillBindingId: input.skillBindingId ?? null,
        executorType: input.executorType ?? "builtin",
      }),
    ],
  );
  return { invocationId: row.id, invocationPublicId: row.public_id, attempt };
}

export async function recoverInterruptedTasks(queryable: Queryable, runId: string) {
  const recovered = await queryable.query<{ study_id: string; task_key: string; attempt: number }>(
    `update study_tasks task set status = 'pending', next_attempt_at = now(),
            error_message = 'WORKER_LEASE_EXPIRED', last_error_code = 'WORKER_LEASE_EXPIRED',
            last_error_class = 'interrupted', retryable = true, finished_at = now(), updated_at = now()
     where task.run_id = $1 and task.status = 'running'
     returning task.study_id::text as study_id, task.task_key, task.attempt`,
    [runId],
  );
  if (!recovered.rows.length) return [];
  await queryable.query(
    `update study_tool_invocations set status = 'interrupted', error_message = 'WORKER_LEASE_EXPIRED', finished_at = now()
     where run_id = $1 and status = 'running'`,
    [runId],
  );
  await queryable.query(
    `update study_task_attempts set status = 'interrupted', error_class = 'interrupted', error_code = 'WORKER_LEASE_EXPIRED',
            error_message = 'WORKER_LEASE_EXPIRED', retryable = true, finished_at = now()
     where run_id = $1 and status = 'running'`,
    [runId],
  );
  await queryable.query(
    `insert into study_events (study_id, run_id, event_type, payload)
     values ($1, $2, 'run.tasks.recovered', $3::jsonb)`,
    [recovered.rows[0].study_id, runId, JSON.stringify({ taskKeys: recovered.rows.map((task) => task.task_key), reason: "WORKER_LEASE_EXPIRED" })],
  );
  return recovered.rows;
}

export async function submitTaskInput(queryable: Queryable, input: {
  workspaceId: string;
  viewerId: string;
  studyPublicId: string;
  taskPublicId: string;
  response: Record<string, unknown>;
}) {
  const pending = await queryable.query<{ input_id: string; study_id: string; run_id: string; task_id: string; task_key: string }>(
    `select request.id::text as input_id, study.id::text as study_id, run.id::text as run_id,
            task.id::text as task_id, task.task_key
     from study_task_inputs request
     join studies study on study.id = request.study_id
     join study_runs run on run.id = request.run_id
     join study_tasks task on task.id = request.task_id
     where study.public_id = $1 and study.workspace_id = $2 and task.public_id = $3
       and request.status = 'pending' and task.status = 'waiting_input'
     for update of request, run, task`,
    [input.studyPublicId, input.workspaceId, input.taskPublicId],
  );
  const row = pending.rows[0];
  if (!row) return "not_found" as const;

  await queryable.query(
    `update study_task_inputs set status = 'consumed', response_payload = $2::jsonb,
            submitted_at = now(), consumed_at = now(), submitted_by = $3
     where id = $1`,
    [row.input_id, JSON.stringify(input.response), input.viewerId],
  );
  await queryable.query(
    `update study_tasks set status = 'pending', input = jsonb_set(input, '{resumeInput}', $2::jsonb, true),
            next_attempt_at = now(), waiting_reason = null, waiting_payload = null, waiting_since = null,
            resumed_at = now(), resume_count = resume_count + 1, error_message = null, updated_at = now()
     where id = $1`,
    [row.task_id, JSON.stringify(input.response)],
  );
  await queryable.query(
    `update study_runs set status = 'queued', error_message = null, finished_at = null where id = $1`,
    [row.run_id],
  );
  await queryable.query(
    `update studies set status = 'queued', current_stage = 'execution', updated_at = now() where id = $1`,
    [row.study_id],
  );
  await queryable.query(
    `insert into study_job_queue (run_id, status, available_at)
     values ($1, 'queued', now())
     on conflict (run_id) do update set status = 'queued', available_at = now(), lease_owner = null,
       lease_expires_at = null, error_message = null, updated_at = now()`,
    [row.run_id],
  );
  await queryable.query(
    `insert into study_events (study_id, run_id, event_type, payload)
     values ($1, $2, 'task.input.submitted', $3::jsonb),
            ($1, $2, 'run.resume_queued', $4::jsonb)`,
    [
      row.study_id, row.run_id,
      JSON.stringify({ taskKey: row.task_key, taskPublicId: input.taskPublicId }),
      JSON.stringify({ taskKey: row.task_key, source: "waiting_input" }),
    ],
  );
  return { runId: row.run_id, taskKey: row.task_key };
}
