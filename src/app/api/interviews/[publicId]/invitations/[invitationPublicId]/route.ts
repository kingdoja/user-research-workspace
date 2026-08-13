import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { revokeInterviewInvitation } from "@/lib/interviews";
import { isSameOriginRequest } from "@/lib/request-security";

export async function DELETE(request: Request, { params }: { params: Promise<{ publicId: string; invitationPublicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { publicId, invitationPublicId } = await params;
  const result = await revokeInterviewInvitation(viewer, publicId, invitationPublicId);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限撤销邀请" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "邀请不存在" }, { status: 404 });
  return NextResponse.json({ revoked: true });
}
