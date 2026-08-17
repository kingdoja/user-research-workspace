import { NextResponse } from "next/server";
import { revokeWorkspaceApiKey } from "@/lib/api-access";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await revokeWorkspaceApiKey(viewer, (await context.params).publicId);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以撤销 API 密钥" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "API 密钥不存在" }, { status: 404 });
  return NextResponse.json({ revokedAt: result });
}
