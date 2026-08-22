import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { checkRateLimit, isSameOriginRequest, rateLimitResponse } from "@/lib/request-security";
import { sendAgentMessage, sendAgentMessageInputSchema } from "@/lib/universal-agent";

export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const rateLimit = checkRateLimit(request, "agent-message", { limit: 30, windowMs: 15 * 60_000 }, `${viewer.workspaceId}:${viewer.userId}`);
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfterSeconds);
  const parsed = sendAgentMessageInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "消息无效" }, { status: 400 });
  const { publicId } = await context.params;
  try {
    const result = await sendAgentMessage(viewer, publicId, parsed.data);
    if (result === "forbidden") return NextResponse.json({ error: "当前角色无权运行 Agent" }, { status: 403 });
    if (result === "not_found") return NextResponse.json({ error: "Agent 会话不存在" }, { status: 404 });
    if ("error" in result && result.error === "busy") {
      return NextResponse.json({ ...result, message: "当前会话已有任务排队或运行中" }, { status: 409 });
    }
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent 入队失败";
    const status = /agent_runs_one_active_thread_idx/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message.slice(0, 800) }, { status });
  }
}
