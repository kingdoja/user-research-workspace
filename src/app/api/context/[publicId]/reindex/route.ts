import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { reindexContextAsset } from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await reindexContextAsset(viewer, (await params).publicId);
  if (result === "not_found") return NextResponse.json({ error: "Context asset 不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "无权重建该 Context 索引" }, { status: 403 });
  if (result === "tombstoned") return NextResponse.json({ error: "已下架的 Context 不能重建索引" }, { status: 409 });
  return NextResponse.json(result);
}
