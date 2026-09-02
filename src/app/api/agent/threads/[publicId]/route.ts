import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { archiveAgentThread } from "@/lib/universal-agent";

export async function DELETE(_request: Request, context: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(_request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId } = await context.params;
  const result = await archiveAgentThread(viewer, publicId);
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权删除 Agent 会话" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "Agent 会话不存在" }, { status: 404 });
  return NextResponse.json({ status: result });
}
