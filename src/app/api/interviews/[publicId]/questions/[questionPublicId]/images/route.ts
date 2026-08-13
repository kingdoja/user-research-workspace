import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { createInterviewImagePath, INTERVIEW_IMAGE_BUCKET, isInterviewImagePath, validateInterviewImage } from "@/lib/interview-images";
import { interviewQuestionImageSchema } from "@/lib/interview-schema";
import { addInterviewQuestionImage, getInterviewQuestionImagePaths, removeInterviewQuestionImage } from "@/lib/interviews";
import { isSameOriginRequest } from "@/lib/request-security";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ publicId: string; questionPublicId: string }> };

export async function POST(request: Request, { params }: Context) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId, questionPublicId } = await params;
  const existing = await getInterviewQuestionImagePaths(viewer, publicId, questionPublicId);
  if (existing === "forbidden") return NextResponse.json({ error: "没有权限管理问题图片" }, { status: 403 });
  if (existing === "not_found") return NextResponse.json({ error: "问题不存在" }, { status: 404 });
  if (existing.length >= 4) return NextResponse.json({ error: "每个问题最多上传 4 张图片" }, { status: 400 });
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("image");
  if (!(file instanceof File)) return NextResponse.json({ error: "请选择图片" }, { status: 400 });
  const validated = await validateInterviewImage(file);
  if ("error" in validated) return NextResponse.json({ error: validated.error }, { status: 400 });
  const imagePath = createInterviewImagePath(publicId, questionPublicId, validated.extension);
  const supabase = await createSupabaseServerClient();
  const { error: uploadError } = await supabase.storage.from(INTERVIEW_IMAGE_BUCKET).upload(imagePath, validated.bytes, {
    contentType: validated.contentType,
    cacheControl: "31536000",
    upsert: false,
  });
  if (uploadError) return NextResponse.json({ error: "图片上传失败，请稍后重试" }, { status: 502 });
  const result = await addInterviewQuestionImage(viewer, publicId, questionPublicId, imagePath);
  if (result === "forbidden" || result === "not_found" || result === "limit_reached") {
    await supabase.storage.from(INTERVIEW_IMAGE_BUCKET).remove([imagePath]);
    const status = result === "forbidden" ? 403 : result === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result === "limit_reached" ? "每个问题最多上传 4 张图片" : "无法保存问题图片" }, { status });
  }
  return NextResponse.json(result, { status: 201 });
}

export async function DELETE(request: Request, { params }: Context) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId, questionPublicId } = await params;
  const parsed = interviewQuestionImageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isInterviewImagePath(publicId, questionPublicId, parsed.data.imagePath)) {
    return NextResponse.json({ error: "图片路径无效" }, { status: 400 });
  }
  const existing = await getInterviewQuestionImagePaths(viewer, publicId, questionPublicId);
  if (existing === "forbidden") return NextResponse.json({ error: "没有权限管理问题图片" }, { status: 403 });
  if (existing === "not_found" || !existing.includes(parsed.data.imagePath)) return NextResponse.json({ error: "图片不存在" }, { status: 404 });
  const supabase = await createSupabaseServerClient();
  const { data: removedObjects, error: storageError } = await supabase.storage.from(INTERVIEW_IMAGE_BUCKET).remove([parsed.data.imagePath]);
  if (storageError || removedObjects.length !== 1) return NextResponse.json({ error: "图片删除失败，请稍后重试" }, { status: 502 });
  const result = await removeInterviewQuestionImage(viewer, publicId, questionPublicId, parsed.data.imagePath);
  if (result !== "removed") return NextResponse.json({ error: "无法更新问题图片" }, { status: result === "forbidden" ? 403 : 404 });
  return NextResponse.json({ deleted: true });
}
