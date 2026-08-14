import { after, NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { enqueueLatestStudyRun, processStudyJobQueue } from "@/lib/research-harness";
import { queueStudyRun } from "@/lib/studies";

export const maxDuration = 300;

export async function POST(request: Request, context: RouteContext<"/api/studies/[publicId]/run">) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }

  const viewer = await getViewer();

  if (!viewer) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { publicId } = await context.params;
  const result = await queueStudyRun(viewer, publicId);

  if (result === "not_found") {
    return NextResponse.json({ error: "研究项目不存在" }, { status: 404 });
  }

  if (result === "plan_not_confirmed") {
    return NextResponse.json({ error: "请先确认并锁定研究计划" }, { status: 409 });
  }

  if (result === "provider_missing") {
    return NextResponse.json(
      { error: "服务器尚未配置 OPENAI_API_KEY" },
      { status: 503 },
    );
  }

  if (result === "waiting_input") {
    return NextResponse.json({ error: "当前研究正在等待补充输入后继续" }, { status: 409 });
  }

  if (result === "queued") {
    await enqueueLatestStudyRun(publicId, viewer.workspaceId);
    after(() => processStudyJobQueue({ maxJobs: 1 }));
  }

  return NextResponse.json({ status: result });
}
