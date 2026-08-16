import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { approveWorkspaceSkillPackage, skillPackageApprovalInputSchema } from "@/lib/skill-gateway";

export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = skillPackageApprovalInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "审批权限无效" }, { status: 400 });
  const result = await approveWorkspaceSkillPackage(viewer, (await context.params).publicId, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "仅工作区管理员可以审批 Skill 包" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "Skill 包不存在或不可见" }, { status: 404 });
  if (result === "revoked" || result === "archived") return NextResponse.json({ error: "此 Skill 不能审批" }, { status: 409 });
  if ("error" in result) return NextResponse.json({ error: "权限授予必须与包声明完全一致", ...result }, { status: 409 });
  return NextResponse.json(result);
}
