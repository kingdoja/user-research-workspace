import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { deleteInterviewProject, updateInterviewProjectStatus } from "@/lib/interviews";
import { updateInterviewProjectSchema } from "@/lib/interview-schema";
import { isSameOriginRequest } from "@/lib/request-security";

type RouteContext = { params: Promise<{ publicId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = updateInterviewProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "项目状态无效" }, { status: 400 });
  const { publicId } = await context.params;
  const result = await updateInterviewProjectStatus(viewer, publicId, parsed.data.status);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限修改该项目" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈项目不存在" }, { status: 404 });
  return NextResponse.json({ status: parsed.data.status });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId } = await context.params;
  const result = await deleteInterviewProject(viewer, publicId);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限删除该项目" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈项目不存在" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
