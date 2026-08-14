import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { getInterviewSessionReplay } from "@/lib/realtime-interviews";
import { getStrategyExperimentComparison } from "@/lib/runtime-control";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const comparison = await getStrategyExperimentComparison(viewer, (await params).publicId);
  if (!comparison) return NextResponse.json({ error: "实验不存在" }, { status: 404 });

  const url = new URL(request.url);
  const hasSelection = url.searchParams.has("leftSession") || url.searchParams.has("rightSession");
  const candidates = new Map(
    comparison.variants.flatMap((variant) => variant.sessions)
      .map((session) => [session.sessionPublicId, session]),
  );
  const defaultLeft = comparison.variants.find((variant) => variant.sessions.length)?.sessions[0] ?? null;
  const defaultRight = comparison.variants
    .find((variant) => variant.variantKey !== defaultLeft?.variantKey && variant.sessions.length)?.sessions[0]
    ?? comparison.variants.flatMap((variant) => variant.sessions)
      .find((session) => session.sessionPublicId !== defaultLeft?.sessionPublicId)
    ?? null;
  const requested = hasSelection
    ? [url.searchParams.get("leftSession")?.trim() || null, url.searchParams.get("rightSession")?.trim() || null]
    : [defaultLeft?.sessionPublicId ?? null, defaultRight?.sessionPublicId ?? null];
  if (requested.some((sessionPublicId) => sessionPublicId && !candidates.has(sessionPublicId))) {
    return NextResponse.json({ error: "所选会话不属于当前实验" }, { status: 400 });
  }

  const replays = await Promise.all(requested.map(async (sessionPublicId) => {
    if (!sessionPublicId) return null;
    const session = candidates.get(sessionPublicId)!;
    return getInterviewSessionReplay(viewer, session.projectPublicId, session.sessionPublicId);
  }));
  return NextResponse.json({
    comparison,
    selected: { left: requested[0], right: requested[1] },
    replays: { left: replays[0], right: replays[1] },
  });
}
