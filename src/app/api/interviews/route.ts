import { NextResponse } from "next/server";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { createInterviewProject, listInterviewProjects, processInterviewJobQueue } from "@/lib/interviews";
import { createInterviewProjectSchema } from "@/lib/interview-schema";
import { describeOpenAIError } from "@/lib/openai-provider";
import { isSameOriginRequest } from "@/lib/request-security";

export const maxDuration = 300;

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ projects: await listInterviewProjects(viewer) });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = createInterviewProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "访谈项目信息无效" }, { status: 400 });
  try {
    const result = await createInterviewProject(viewer, parsed.data);
    if (result.queued) after(() => processInterviewJobQueue({ maxJobs: 1 }));
    return NextResponse.json({
      publicId: result.publicId,
      queued: result.queued,
      redirectTo: `/interview/projects/${result.publicId}`,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "PERSONA_NOT_FOUND") return NextResponse.json({ error: "所选 Persona 不存在或不可见" }, { status: 404 });
    if (error instanceof Error && error.message === "PANEL_NOT_FOUND") return NextResponse.json({ error: "所选 Panel 不存在" }, { status: 404 });
    if (error instanceof Error && error.message === "STUDY_NOT_FOUND") return NextResponse.json({ error: "所选研究不存在" }, { status: 404 });
    if (error instanceof Error && error.message === "PROVIDER_NOT_CONFIGURED") return NextResponse.json({ error: "模型服务尚未配置" }, { status: 503 });
    const providerError = describeOpenAIError(error);
    return NextResponse.json({ error: providerError.message }, { status: 502 });
  }
}
