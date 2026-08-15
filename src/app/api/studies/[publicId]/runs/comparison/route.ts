import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { getStudyRunComparison } from "@/lib/study-run-replay";

export async function GET(request: Request, context: RouteContext<"/api/studies/[publicId]/runs/comparison">) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { publicId } = await context.params;
  const url = new URL(request.url);
  const comparison = await getStudyRunComparison(
    viewer,
    publicId,
    url.searchParams.get("left"),
    url.searchParams.get("right"),
  );
  if (!comparison) return NextResponse.json({ error: "研究或运行记录不存在" }, { status: 404 });
  return NextResponse.json({ comparison });
}
