import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { setWorkspaceSkillEnabled, skillActivationInputSchema } from "@/lib/skill-gateway";

export async function PATCH(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = skillActivationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Skill 设置无效" }, { status: 400 });
  const result = await setWorkspaceSkillEnabled(viewer, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "Skill 不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权修改该 Skill" }, { status: 403 });
  if (result === "unconfigured") return NextResponse.json({ error: "Skill 尚未配置 Executor" }, { status: 409 });
  if (result === "archived") return NextResponse.json({ error: "已归档 Skill 不能启用" }, { status: 409 });
  if (result === "revoked") return NextResponse.json({ error: "已撤销 Skill 不能启用" }, { status: 409 });
  if (result === "pending_approval") return NextResponse.json({ error: "导入的 Skill 需要管理员审批权限后才能启用" }, { status: 409 });
  if (typeof result === "object" && "error" in result && result.error === "capability_denied") {
    return NextResponse.json({ error: `Skill 缺少权限授予：${result.missing.join(", ")}` }, { status: 409 });
  }
  return NextResponse.json(result);
}
