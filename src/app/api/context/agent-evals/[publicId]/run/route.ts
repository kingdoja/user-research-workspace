import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { agentEvalRunInputSchema, runAgentEvalSuite } from "@/lib/agent-evals";
import { checkRateLimit, isSameOriginRequest, rateLimitResponse } from "@/lib/request-security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const rateLimit = checkRateLimit(request, "agent-evaluation-run", { limit: 10, windowMs: 60 * 60_000 }, `${viewer.workspaceId}:${viewer.userId}`);
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfterSeconds);
  const parsed = agentEvalRunInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Agent Eval 输出无效" }, { status: 400 });
  const result = await runAgentEvalSuite(viewer, (await params).publicId, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以运行 Agent Eval" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "Agent Eval suite 不存在或未启用" }, { status: 404 });
  if (result === "case_output_mismatch" || result === "duplicate_case_output") {
    return NextResponse.json({ error: "必须且只能为 suite 中每个 case 提交一份输出" }, { status: 400 });
  }
  return NextResponse.json(result);
}
