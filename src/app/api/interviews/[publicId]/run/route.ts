import { after } from "next/server";
import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { processInterviewJobQueue, queueInterviewRun } from "@/lib/interviews";
import { isSameOriginRequest } from "@/lib/request-security";

export const maxDuration = 300;

type RouteContext = { params: Promise<{ publicId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId } = await context.params;
  const result = await queueInterviewRun(viewer, publicId);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限重新执行该项目" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈项目不存在" }, { status: 404 });
  if (result === "provider_missing") return NextResponse.json({ error: "模型服务尚未配置" }, { status: 503 });
  if (result === "no_personas") return NextResponse.json({ error: "该项目没有可生成的 AI Persona" }, { status: 409 });
  if (result === "completed") return NextResponse.json({ error: "该项目的 AI 访谈已经生成" }, { status: 409 });
  if (result === "already_running") return NextResponse.json({ error: "生成任务仍在执行中" }, { status: 409 });
  after(() => processInterviewJobQueue({ maxJobs: 1 }));
  return NextResponse.json({ status: "queued" }, { status: 202 });
}
