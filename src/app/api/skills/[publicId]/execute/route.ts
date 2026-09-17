import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { checkRateLimit, isSameOriginRequest, rateLimitResponse } from "@/lib/request-security";
import { executeWorkspaceSkill, skillExecutionInputSchema } from "@/lib/skill-gateway";
import { SkillExecutionError } from "@/lib/skill-executor";

export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const rateLimit = await checkRateLimit(request, "skill-execute", { limit: 30, windowMs: 15 * 60_000 }, `${viewer.workspaceId}:${viewer.userId}`);
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfterSeconds);
  const parsed = skillExecutionInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Skill 输入无效" }, { status: 400 });
  const { publicId } = await context.params;
  try {
    const result = await executeWorkspaceSkill(viewer, publicId, parsed.data.arguments);
    if (result === "not_found") return NextResponse.json({ error: "Skill 不存在" }, { status: 404 });
    if (result === "forbidden") return NextResponse.json({ error: "当前角色无权执行 Skill" }, { status: 403 });
    if (result === "disabled") return NextResponse.json({ error: "Skill 已禁用" }, { status: 409 });
    if (result === "unconfigured") return NextResponse.json({ error: "Skill 尚未配置 Executor" }, { status: 409 });
    if (typeof result === "object" && "error" in result && result.error === "capability_denied") {
      return NextResponse.json({ error: `Skill 缺少权限授予：${result.missing.join(", ")}` }, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SkillExecutionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 422 });
    }
    throw error;
  }
}
