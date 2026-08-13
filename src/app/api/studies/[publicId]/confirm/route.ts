import { after, NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { enqueueLatestStudyRun, processStudyJobQueue } from "@/lib/research-harness";
import { confirmStudyPlan } from "@/lib/studies";

export const maxDuration = 300;

export async function POST(request: Request, context: RouteContext<"/api/studies/[publicId]/confirm">) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }

  const viewer = await getViewer();

  if (!viewer) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { publicId } = await context.params;
  const result = await confirmStudyPlan(viewer, publicId);

  if (result === "not_found") {
    return NextResponse.json({ error: "研究项目不存在" }, { status: 404 });
  }

  if (result === "confirmed") {
    await enqueueLatestStudyRun(publicId, viewer.workspaceId);
    after(() => processStudyJobQueue({ maxJobs: 1 }));
  }

  return NextResponse.json({ status: result });
}
