import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { interviewQualityReviewSchema } from "@/lib/interview-schema";
import { saveInterviewQualityReview } from "@/lib/realtime-interviews";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: Request, { params }: { params: Promise<{ publicId: string; sessionPublicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = interviewQualityReviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "评分无效" }, { status: 400 });
  const { publicId, sessionPublicId } = await params;
  const result = await saveInterviewQualityReview(viewer, publicId, sessionPublicId, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限提交质量评分" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈会话不存在" }, { status: 404 });
  return NextResponse.json({ review: result });
}
