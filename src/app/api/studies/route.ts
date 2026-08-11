import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { createStudy, listStudies } from "@/lib/studies";

export const maxDuration = 120;

const createStudySchema = z.object({
  brief: z.string().trim().min(12, "请再具体描述一些研究问题").max(4000, "研究问题不能超过 4000 个字符"),
});

export async function GET() {
  const viewer = await getViewer();

  if (!viewer) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  return NextResponse.json({ studies: await listStudies(viewer, 50) });
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

  const publicId = await createStudy(viewer, parsed.data.brief);
  return NextResponse.json({ publicId, redirectTo: `/study/${publicId}` }, { status: 201 });
}
