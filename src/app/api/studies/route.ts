import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { createStudy, listStudies } from "@/lib/studies";

export const maxDuration = 120;

const createStudySchema = z.object({
  brief: z.string().trim().min(12, "请再具体描述一些研究问题").max(4000, "研究问题不能超过 4000 个字符"),
  productLine: z.enum(["research", "market_insight"]).default("research"),
  sourcePanelPublicId: z.string().trim().min(8).max(120).optional(),
  gptResearcherReportType: z.enum(["research_report", "deep", "detailed_report", "subtopic_report"]).default("research_report"),
});

export async function GET() {
  const viewer = await getViewer();

  if (!viewer) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  try {
    return NextResponse.json({ studies: await listStudies(viewer, 50) });
  } catch (error) {
    console.error("[api/studies] failed to list studies", error);
    return NextResponse.json({ error: "暂时无法加载研究项目，请稍后重试" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }

  const viewer = await getViewer();

  if (!viewer) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const parsed = createStudySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "研究问题无效" },
      { status: 400 },
    );
  }

  try {
    const publicId = await createStudy(
      viewer,
      parsed.data.brief,
      parsed.data.productLine,
      parsed.data.sourcePanelPublicId,
      parsed.data.gptResearcherReportType,
    );
    return NextResponse.json({ publicId, redirectTo: `/study/${publicId}` }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "PANEL_NOT_FOUND") {
      return NextResponse.json({ error: "Panel 不存在或不属于当前工作区" }, { status: 404 });
    }
    console.error("[api/studies] failed to create study", error);
    return NextResponse.json({ error: "创建研究失败，请稍后重试" }, { status: 500 });
  }
}
