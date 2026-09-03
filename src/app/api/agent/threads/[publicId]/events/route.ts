import { getViewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type AgentStepEvent = {
  id: string;
  run_public_id: string;
  kind: string;
  status: string;
  sequence: number;
  decision_summary: string;
  tool_name: string | null;
  output: Record<string, unknown> | string | null;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
};

type AgentStreamEvent = {
  id: string;
  run_public_id: string;
  event_type: string;
  content: string;
  metadata: Record<string, unknown> | string;
  created_at: string;
};

const MAX_SSE_OUTPUT_BYTES = 16_384;

function summarizeOutput(output: Record<string, unknown> | null) {
  if (!output) return output;
  const bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (bytes <= MAX_SSE_OUTPUT_BYTES) return output;
  const summaryKeys = ["status", "resourceType", "resourcePublicId", "href", "summary", "nextAction", "error"];
  return {
    ...Object.fromEntries(summaryKeys.flatMap((key) => key in output ? [[key, output[key]]] : [])),
    truncated: true,
    originalByteSize: bytes,
  };
}

function toSse(event: AgentStepEvent, cursorId: string) {
  const parsedOutput = typeof event.output === "string" ? JSON.parse(event.output) as Record<string, unknown> : event.output;
  return `id: ${cursorId}\nevent: agent-step\ndata: ${JSON.stringify({
    id: event.id,
    runPublicId: event.run_public_id,
    kind: event.kind,
    status: event.status,
    sequence: event.sequence,
    summary: event.decision_summary,
    toolName: event.tool_name,
    output: summarizeOutput(parsedOutput),
    errorCode: event.error_code,
    createdAt: event.created_at,
    finishedAt: event.finished_at,
  })}\n\n`;
}

function toStreamSse(event: AgentStreamEvent, cursorId: string) {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = typeof event.metadata === "string" ? JSON.parse(event.metadata) as Record<string, unknown> : event.metadata;
  } catch {
    metadata = {};
  }
  return `id: ${cursorId}\nevent: agent-stream\ndata: ${JSON.stringify({
    id: event.id,
    runPublicId: event.run_public_id,
    type: event.event_type,
    content: event.content,
    metadata,
    createdAt: event.created_at,
  })}\n\n`;
}

export async function GET(request: Request, context: { params: Promise<{ publicId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ error: "请先登录" }, { status: 401 });
  const { publicId } = await context.params;
  const database = await getDatabase();
  const threadResult = await database.query<{ id: string }>(
    "select id::text as id from agent_threads where public_id = $1 and workspace_id = $2 limit 1",
    [publicId, viewer.workspaceId],
  );
  const thread = threadResult.rows[0];
  if (!thread) return Response.json({ error: "Agent 会话不存在" }, { status: 404 });

  const url = new URL(request.url);
  const rawCursor = request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0";
  let stepCursor = BigInt(0);
  let streamCursor = BigInt(0);
  const compoundMatch = rawCursor.match(/^cursor:(\d+):(\d+)$/);
  const stepMatch = rawCursor.match(/^step:(\d+)$/);
  const streamMatch = rawCursor.match(/^stream:(\d+)$/);
  if (compoundMatch) {
    stepCursor = BigInt(compoundMatch[1]);
    streamCursor = BigInt(compoundMatch[2]);
  } else if (stepMatch) stepCursor = BigInt(stepMatch[1]);
  else if (streamMatch) streamCursor = BigInt(streamMatch[1]);
  else if (/^\d+$/.test(rawCursor)) stepCursor = BigInt(rawCursor);
  const runPublicId = url.searchParams.get("run");
  const encoder = new TextEncoder();
  let closed = false;
  let terminalStreamEventSeen = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      request.signal.addEventListener("abort", close, { once: true });
      const deadline = Date.now() + 25_000;
      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
        while (!closed && Date.now() < deadline) {
          const streamTable = "agent_run_stream_events";
          const [stepResult, streamResult] = await Promise.all([
            database.query<AgentStepEvent>(
              `select step.id::text as id, run.public_id as run_public_id, step.kind, step.status, step.sequence,
                      step.decision_summary, step.tool_name, step.output,
                      step.error_code, step.started_at::text as created_at, step.finished_at::text as finished_at
               from agent_steps step join agent_runs run on run.id = step.run_id
               where run.thread_id = $1 and ($2::text is null or run.public_id = $2) and step.id > $3
               order by step.id asc limit 100`,
              [thread.id, runPublicId, stepCursor.toString()],
            ),
            database.query<AgentStreamEvent>(
              `select event.id::text as id, run.public_id as run_public_id, event.event_type,
                      event.content, event.metadata, event.created_at::text as created_at
               from ${streamTable} event join agent_runs run on run.id = event.run_id
               where event.thread_id = $1 and ($2::text is null or run.public_id = $2) and event.id > $3
               order by event.id asc limit 200`,
              [thread.id, runPublicId, streamCursor.toString()],
            ),
          ]);
          const pending = [
            ...stepResult.rows.map((event) => ({ kind: "step" as const, event, at: Date.parse(event.created_at) })),
            ...streamResult.rows.map((event) => ({ kind: "stream" as const, event, at: Date.parse(event.created_at) })),
          ].sort((left, right) => left.at - right.at);
          for (const item of pending) {
            if (closed) break;
            if (item.kind === "step") {
              stepCursor = BigInt(item.event.id);
              controller.enqueue(encoder.encode(toSse(item.event, `cursor:${stepCursor}:${streamCursor}`)));
            } else {
              streamCursor = BigInt(item.event.id);
              if (item.event.event_type === "assistant.commit" || item.event.event_type === "assistant.error") {
                terminalStreamEventSeen = true;
              }
              controller.enqueue(encoder.encode(toStreamSse(item.event, `cursor:${stepCursor}:${streamCursor}`)));
            }
          }
          if (pending.length === 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          if (runPublicId) {
            const runStatus = await database.query<{ status: string }>(
              "select status from agent_runs where public_id = $1 and thread_id = $2 limit 1",
              [runPublicId, thread.id],
            );
            if (
              ["completed", "failed", "blocked", "cancelled"].includes(runStatus.rows[0]?.status ?? "")
              && terminalStreamEventSeen
            ) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      } catch (error) {
        if (!closed) controller.error(error);
        closed = true;
        return;
      }
      close();
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
