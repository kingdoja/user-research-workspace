import { getViewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type StreamEvent = {
  id: string;
  type: string;
  payload: Record<string, unknown> | string;
  created_at: string;
};

function toSse(event: StreamEvent) {
  const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
  return `id: ${event.id}\nevent: study-event\ndata: ${JSON.stringify({
    id: event.id,
    type: event.type,
    payload,
    createdAt: event.created_at,
  })}\n\n`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ error: "请先登录" }, { status: 401 });

  const { publicId } = await context.params;
  const database = await getDatabase();
  const studyResult = await database.query<{ id: string }>(
    "select id::text as id from studies where public_id = $1 and workspace_id = $2 limit 1",
    [publicId, viewer.workspaceId],
  );
  const study = studyResult.rows[0];
  if (!study) return Response.json({ error: "研究项目不存在" }, { status: 404 });

  const url = new URL(request.url);
  const headerCursor = request.headers.get("last-event-id");
  const rawCursor = headerCursor ?? url.searchParams.get("after") ?? "0";
  let cursor = /^\d+$/.test(rawCursor) ? BigInt(rawCursor) : BigInt(0);
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
          const result = await database.query<StreamEvent>(
            `select id::text as id, event_type as type, payload, created_at::text as created_at
             from study_events
             where study_id = $1 and id > $2
             order by id asc
             limit 100`,
            [study.id, cursor.toString()],
          );

          for (const event of result.rows) {
            if (closed) break;
            controller.enqueue(encoder.encode(toSse(event)));
            cursor = BigInt(event.id);
          }

          if (result.rows.some((event) => ["research.completed", "run.failed", "run.cancelled"].includes(event.type))) {
            break;
          }
          if (result.rows.length === 0) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
          await new Promise((resolve) => setTimeout(resolve, 900));
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
