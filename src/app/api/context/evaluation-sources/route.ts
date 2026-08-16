import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { listContextEvaluationSourceChunks } from "@/lib/context-system";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (viewer.role !== "owner" && viewer.role !== "admin") {
    return NextResponse.json({ error: "只有管理员可以查看评估样本" }, { status: 403 });
  }
  return NextResponse.json({ sources: await listContextEvaluationSourceChunks(viewer) });
}
