import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { deleteInterviewProject, getInterviewQuestionImagePaths, updateInterviewProjectDetails, updateInterviewProjectStatus } from "@/lib/interviews";
import { updateInterviewProjectDetailsSchema, updateInterviewProjectSchema } from "@/lib/interview-schema";
import { isSameOriginRequest } from "@/lib/request-security";
import { INTERVIEW_IMAGE_BUCKET } from "@/lib/interview-images";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ publicId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const { publicId } = await context.params;
  const statusInput = updateInterviewProjectSchema.safeParse(body);
  const detailsInput = updateInterviewProjectDetailsSchema.safeParse(body);
  if (!statusInput.success && !detailsInput.success) return NextResponse.json({ error: "项目信息无效" }, { status: 400 });
  const result = statusInput.success
    ? await updateInterviewProjectStatus(viewer, publicId, statusInput.data.status)
    : detailsInput.success
      ? await updateInterviewProjectDetails(viewer, publicId, detailsInput.data.objective)
      : "not_found" as const;
  if (result === "forbidden") return NextResponse.json({ error: "没有权限修改该项目" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈项目不存在" }, { status: 404 });
  return NextResponse.json(statusInput.success ? { status: statusInput.data.status } : { updated: true });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId } = await context.params;
  const imagePaths = await getInterviewQuestionImagePaths(viewer, publicId);
  if (imagePaths === "forbidden") return NextResponse.json({ error: "没有权限删除该项目" }, { status: 403 });
  if (imagePaths === "not_found") return NextResponse.json({ error: "访谈项目不存在" }, { status: 404 });
  if (imagePaths.length > 0) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.storage.from(INTERVIEW_IMAGE_BUCKET).remove(imagePaths);
    if (error || data.length !== imagePaths.length) return NextResponse.json({ error: "项目图片清理失败，请稍后重试" }, { status: 502 });
  }
  const result = await deleteInterviewProject(viewer, publicId);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限删除该项目" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈项目不存在" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
