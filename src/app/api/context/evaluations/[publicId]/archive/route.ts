import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { archiveContextEvaluationSet } from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await archiveContextEvaluationSet(viewer, (await params).publicId);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以归档检索评估集" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "检索评估集不存在或已归档" }, { status: 404 });
  return NextResponse.json(result);
}
