import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { getInterviewSessionReplay } from "@/lib/realtime-interviews";

export async function GET(_request: Request, { params }: { params: Promise<{ publicId: string; sessionPublicId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId, sessionPublicId } = await params;
  const replay = await getInterviewSessionReplay(viewer, publicId, sessionPublicId);
  if (!replay) return NextResponse.json({ error: "访谈会话不存在" }, { status: 404 });
  return NextResponse.json({ replay });
}
