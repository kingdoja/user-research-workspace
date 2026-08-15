import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { contextEdgeInputSchema, createContextEdge } from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = contextEdgeInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "资产关系无效" }, { status: 400 });
  const result = await createContextEdge(viewer, (await params).publicId, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "无权管理该资产关系" }, { status: 403 });
  if (result === "source_not_found" || result === "target_not_found") return NextResponse.json({ error: "关联资产不存在" }, { status: 404 });
  if (result === "self_relation") return NextResponse.json({ error: "资产不能关联自己" }, { status: 400 });
  if (result === "tombstoned") return NextResponse.json({ error: "已下架资产不能建立关系" }, { status: 409 });
  return NextResponse.json(result, { status: 201 });
}
