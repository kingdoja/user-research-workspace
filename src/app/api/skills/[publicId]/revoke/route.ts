import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { revokeWorkspaceSkill } from "@/lib/skill-gateway";

export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await revokeWorkspaceSkill(viewer, (await context.params).publicId);
  if (result === "forbidden") return NextResponse.json({ error: "仅工作区管理员可以撤销 Skill" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "Skill 不存在" }, { status: 404 });
  if (result === "archived") return NextResponse.json({ error: "已归档 Skill 不能撤销" }, { status: 409 });
  return NextResponse.json(result);
}
