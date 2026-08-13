import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { createInterviewQuestion } from "@/lib/interviews";
import { interviewQuestionSchema } from "@/lib/interview-schema";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = interviewQuestionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "问题内容无效" }, { status: 400 });
  const { publicId } = await params;
  const result = await createInterviewQuestion(viewer, publicId, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限管理问题" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈项目不存在" }, { status: 404 });
  return NextResponse.json(result, { status: 201 });
}
