import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { updateStudyShare } from "@/lib/studies";

const shareSchema = z.object({ enabled: z.boolean() });

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = shareSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "分享设置无效" }, { status: 400 });

  const { publicId } = await context.params;
  const result = await updateStudyShare(viewer, publicId, parsed.data.enabled);
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权修改分享设置" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "研究报告不存在" }, { status: 404 });

  return NextResponse.json({
    enabled: parsed.data.enabled,
    shareUrl: result.shareToken ? `/shared/${result.shareToken}` : null,
  });
}
