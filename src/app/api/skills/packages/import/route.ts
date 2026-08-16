import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { importWorkspaceSkillPackage, skillPackageInputSchema } from "@/lib/skill-gateway";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = skillPackageInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? ".skill 包无效" }, { status: 400 });
  const result = await importWorkspaceSkillPackage(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权导入 Skill" }, { status: 403 });
  if (result === "conflict") return NextResponse.json({ error: "Skill slug 已存在" }, { status: 409 });
  return NextResponse.json(result, { status: 201 });
}
