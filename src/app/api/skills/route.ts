import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { listResearchSkills } from "@/lib/research-harness";
import {
  createWorkspaceSkill,
  listWorkspaceSkills,
  skillManifestInputSchema,
} from "@/lib/skill-gateway";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const workspaceSkills = await listWorkspaceSkills(viewer);
  return NextResponse.json({ skills: [...listResearchSkills(), ...workspaceSkills] });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = skillManifestInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Skill manifest 无效" }, { status: 400 });
  const result = await createWorkspaceSkill(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权创建 Skill" }, { status: 403 });
  if (result === "conflict") return NextResponse.json({ error: "Skill slug 已存在" }, { status: 409 });
  return NextResponse.json(result, { status: 201 });
}
