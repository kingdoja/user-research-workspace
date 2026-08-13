import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { publishWorkspaceSkillVersion, skillVersionInputSchema } from "@/lib/skill-gateway";

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = skillVersionInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Skill version 无效" }, { status: 400 });
  const result = await publishWorkspaceSkillVersion(viewer, (await context.params).publicId, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "Skill 不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权发布该 Skill" }, { status: 403 });
  return NextResponse.json(result, { status: 201 });
}
