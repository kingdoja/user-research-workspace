import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { submitStudyFollowup } from "@/lib/studies";

export const maxDuration = 180;

const followupSchema = z.object({
  question: z.string().trim().min(6, "请提供更具体的追问").max(1000, "追问不能超过 1000 个字符"),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = followupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "追问内容无效" }, { status: 400 });
  }

  const { publicId } = await context.params;
  const result = await submitStudyFollowup(viewer, publicId, parsed.data.question);
  if (result === "not_found") return NextResponse.json({ error: "已完成的研究不存在" }, { status: 404 });
  if (result === "report_missing") return NextResponse.json({ error: "研究报告尚未生成" }, { status: 409 });
  if (result.status === "provider_failed") {
    const status = result.error.code === "DEEPSEEK_API_KEY_MISSING" ? 503 : 502;
    return NextResponse.json({ error: result.error.message, code: result.error.code }, { status });
  }
  return NextResponse.json({ status: result.status });
}
