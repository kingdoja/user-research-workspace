import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { contextEmbeddingEvaluationInputSchema, runContextEvaluation } from "@/lib/context-system";
import { checkRateLimit, isSameOriginRequest, rateLimitResponse } from "@/lib/request-security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const rateLimit = checkRateLimit(request, "context-evaluation-run", { limit: 5, windowMs: 60 * 60_000 }, `${viewer.workspaceId}:${viewer.userId}`);
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfterSeconds);
  const parsed = contextEmbeddingEvaluationInputSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Embedding 评估配置无效" }, { status: 400 });
  try {
    const result = await runContextEvaluation(viewer, (await params).publicId, parsed.data);
    if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以运行检索评估" }, { status: 403 });
    if (result === "not_found") return NextResponse.json({ error: "检索评估集不存在" }, { status: 404 });
    if (result === "insufficient_human_labels") return NextResponse.json({ error: "检索评估至少需要 20 条人工确认标签" }, { status: 422 });
    if (result === "embedding_endpoint_not_configured") return NextResponse.json({ error: "候选 embedding Provider 未配置。请设置独立的 OPENAI_EMBEDDING_BASE_URL 和匹配的 CONTEXT_EMBEDDING_API_STYLE" }, { status: 503 });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "OPENAI_EMBEDDING_API_KEY_MISSING") {
      return NextResponse.json({ error: "服务器尚未配置 OPENAI_API_KEY，无法评测 OpenAI embedding" }, { status: 503 });
    }
    if (error instanceof Error && error.message === "CONTEXT_EMBEDDING_EVALUATION_INPUT_LIMIT_EXCEEDED") {
      return NextResponse.json({ error: "评估候选文本超过 5000 条上限，请缩小评估集或先拆分运行" }, { status: 422 });
    }
    throw error;
  }
}
