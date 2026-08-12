import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { citeInterviewInsight } from "@/lib/interviews";
import { citeInterviewInsightSchema } from "@/lib/interview-schema";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = citeInterviewInsightSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "访谈洞察无效" }, { status: 400 });
  const { publicId } = await params;
  const result = await citeInterviewInsight(viewer, publicId, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限更新研究报告" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈会话不存在" }, { status: 404 });
  if (result === "report_missing") return NextResponse.json({ error: "关联研究还没有可写入的报告" }, { status: 409 });
  return NextResponse.json({ cited: true, duplicate: result === "duplicate" });
}
