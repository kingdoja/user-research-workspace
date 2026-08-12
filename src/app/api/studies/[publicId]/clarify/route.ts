import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { submitStudyClarification } from "@/lib/studies";

export const maxDuration = 180;

const answerSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().min(1).max(80),
    selected: z.array(z.string().min(1).max(240)).min(1).max(4),
  })).min(1).max(8),
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

  const parsed = answerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请完成所有澄清问题" }, { status: 400 });
  }

  const { publicId } = await context.params;
  const result = await submitStudyClarification(viewer, publicId, parsed.data.answers);

  if (result === "not_found") {
    return NextResponse.json({ error: "研究项目不存在" }, { status: 404 });
  }
  if (result === "invalid_answers") {
    return NextResponse.json({ error: "澄清答案与当前问题不匹配" }, { status: 400 });
  }
  if (result === "already_confirmed") {
    return NextResponse.json({ error: "研究计划已经确认" }, { status: 409 });
  }

  return NextResponse.json({ status: result });
}
