import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { deleteInterviewQuestion, getInterviewQuestionImagePaths, moveInterviewQuestion, updateInterviewQuestion } from "@/lib/interviews";
import { interviewQuestionSchema, moveInterviewQuestionSchema } from "@/lib/interview-schema";
import { isSameOriginRequest } from "@/lib/request-security";
import { INTERVIEW_IMAGE_BUCKET } from "@/lib/interview-images";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ publicId: string; questionPublicId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const questionInput = interviewQuestionSchema.safeParse(body);
  const moveInput = moveInterviewQuestionSchema.safeParse(body);
  if (!questionInput.success && !moveInput.success) return NextResponse.json({ error: "问题更新内容无效" }, { status: 400 });
  const { publicId, questionPublicId } = await params;
  const result = questionInput.success
    ? await updateInterviewQuestion(viewer, publicId, questionPublicId, questionInput.data)
    : moveInput.success
      ? await moveInterviewQuestion(viewer, publicId, questionPublicId, moveInput.data.direction)
      : "not_found" as const;
  if (result === "forbidden") return NextResponse.json({ error: "没有权限管理问题" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "问题不存在" }, { status: 404 });
  return NextResponse.json({ updated: true });
}

export async function DELETE(request: Request, { params }: Context) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId, questionPublicId } = await params;
  const imagePaths = await getInterviewQuestionImagePaths(viewer, publicId, questionPublicId);
  if (imagePaths === "forbidden") return NextResponse.json({ error: "没有权限管理问题" }, { status: 403 });
  if (imagePaths === "not_found") return NextResponse.json({ error: "问题不存在" }, { status: 404 });
  if (imagePaths.length > 0) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.storage.from(INTERVIEW_IMAGE_BUCKET).remove(imagePaths);
    if (error || data.length !== imagePaths.length) return NextResponse.json({ error: "问题图片清理失败，请稍后重试" }, { status: 502 });
  }
  const result = await deleteInterviewQuestion(viewer, publicId, questionPublicId);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限管理问题" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "问题不存在" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
