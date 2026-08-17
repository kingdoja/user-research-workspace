import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { getAgentWorkspaceFile } from "@/lib/universal-agent";

export async function GET(_request: Request, context: { params: Promise<{ publicId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId } = await context.params;
  const result = await getAgentWorkspaceFile(viewer, publicId);
  if (result === "not_found") return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  return NextResponse.json(result);
}
