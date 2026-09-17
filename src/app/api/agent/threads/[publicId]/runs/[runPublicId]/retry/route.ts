import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { internalErrorResponse, isSameOriginRequest } from "@/lib/request-security";
import { retryAgentRun, retryAgentRunInputSchema } from "@/lib/universal-agent";

export async function POST(request: Request, context: {
  params: Promise<{ publicId: string; runPublicId: string }>;
}) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = retryAgentRunInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "重试参数无效" }, { status: 400 });
  const { publicId, runPublicId } = await context.params;
  try {
    const result = await retryAgentRun(viewer, publicId, runPublicId, parsed.data);
    if (result === "forbidden") return NextResponse.json({ error: "当前角色无权重试 Agent Run" }, { status: 403 });
    if (result === "not_found") return NextResponse.json({ error: "Agent Run 不存在" }, { status: 404 });
    if (result === "not_retryable") return NextResponse.json({ error: "只能重试失败或已阻断的 Run" }, { status: 409 });
    if (result === "execution_confirmation_required") {
      return NextResponse.json({ error: "此 Run 曾允许副作用，重试前必须再次确认执行" }, { status: 409 });
    }
    if ("error" in result && result.error === "busy") {
      return NextResponse.json({ ...result, message: "当前会话已有任务排队或运行中" }, { status: 409 });
    }
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent 重试入队失败";
    if (/agent_runs_one_active_thread_idx/.test(message)) {
      return NextResponse.json({ error: "当前会话已有任务排队或运行中" }, { status: 409 });
    }
    return internalErrorResponse(error, "Agent 重试入队失败");
  }
}
