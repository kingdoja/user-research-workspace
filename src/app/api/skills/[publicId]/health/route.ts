import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { probeWorkspaceSkill } from "@/lib/skill-gateway";

export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await probeWorkspaceSkill(viewer, (await context.params).publicId);
  if (result === "forbidden") return NextResponse.json({ error: "仅工作区管理员可以探测 Executor" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "Skill 不存在" }, { status: 404 });
  if (result === "unconfigured") return NextResponse.json({ error: "Skill 尚未配置 Executor" }, { status: 409 });
  if (result === "revoked" || result === "archived") return NextResponse.json({ error: "此 Skill 不可探测" }, { status: 409 });
  if (typeof result === "object" && "error" in result && result.error === "capability_denied") {
    return NextResponse.json({ error: `Skill 缺少权限授予：${result.missing.join(", ")}` }, { status: 409 });
  }
  return NextResponse.json(result);
}
