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

function toSse(event: AgentStepEvent) {
  const output = typeof event.output === "string" ? JSON.parse(event.output) : event.output;
  return `id: ${event.id}\nevent: agent-step\ndata: ${JSON.stringify({
    id: event.id,
    runPublicId: event.run_public_id,
    kind: event.kind,
    status: event.status,
    sequence: event.sequence,
    summary: event.decision_summary,
    toolName: event.tool_name,
    output,
    errorCode: event.error_code,
    createdAt: event.created_at,
    finishedAt: event.finished_at,
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
  let cursor = /^\d+$/.test(rawCursor) ? BigInt(rawCursor) : BigInt(0);
  const runPublicId = url.searchParams.get("run");
  const encoder = new TextEncoder();
  let closed = false;
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
          const result = await database.query<AgentStepEvent>(
            `select step.id::text as id, run.public_id as run_public_id, step.kind, step.status, step.sequence,
                    step.decision_summary, step.tool_name, step.output,
                    step.error_code, step.started_at::text as created_at, step.finished_at::text as finished_at
             from agent_steps step join agent_runs run on run.id = step.run_id
             where run.thread_id = $1 and ($2::text is null or run.public_id = $2) and step.id > $3
             order by step.id asc limit 100`,
            [thread.id, runPublicId, cursor.toString()],
          );
          for (const event of result.rows) {
            if (closed) break;
            controller.enqueue(encoder.encode(toSse(event)));
            cursor = BigInt(event.id);
          }
          if (result.rows.length === 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          if (runPublicId) {
            const runStatus = await database.query<{ status: string }>(
              "select status from agent_runs where public_id = $1 and thread_id = $2 limit 1",
              [runPublicId, thread.id],
            );
            if (["completed", "failed", "cancelled"].includes(runStatus.rows[0]?.status ?? "")) break;
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
