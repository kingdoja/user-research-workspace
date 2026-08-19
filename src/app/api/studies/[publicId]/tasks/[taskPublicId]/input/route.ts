import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { processStudyJobQueue } from "@/lib/research-harness";
import { isSameOriginRequest } from "@/lib/request-security";
import { submitStudyTaskInput } from "@/lib/studies";

export const maxDuration = 180;

const responseSchema = z.object({
  response: z.record(z.string().max(80), z.union([
    z.string().max(2000),
    z.array(z.string().max(2048)).max(8),
  ])).refine((value) => Object.keys(value).length <= 8, "提交字段过多"),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string; taskPublicId: string }> },
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = responseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "输入格式无效" }, { status: 400 });

  const { publicId, taskPublicId } = await context.params;
  const result = await submitStudyTaskInput(viewer, publicId, taskPublicId, parsed.data.response);
  if (result === "forbidden") return NextResponse.json({ error: "当前角色不能继续研究" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "待补充输入的任务不存在或已处理" }, { status: 404 });
  if ("validationError" in result) return NextResponse.json({ error: result.validationError }, { status: 400 });

  after(() => processStudyJobQueue({ maxJobs: 1 }));
  return NextResponse.json({ status: "queued", runId: result.runId, taskKey: result.taskKey });
}
