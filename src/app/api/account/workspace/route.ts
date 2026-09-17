import { NextResponse } from "next/server";
import { ACTIVE_WORKSPACE_COOKIE, getViewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = await request.json().catch(() => null) as { workspacePublicId?: unknown } | null;
  const workspacePublicId = typeof body?.workspacePublicId === "string"
    ? body.workspacePublicId.trim()
    : "";
  if (workspacePublicId.length < 8 || workspacePublicId.length > 120) {
    return NextResponse.json({ error: "工作区无效" }, { status: 400 });
  }

  const database = await getDatabase();
  const membership = await database.query<{ public_id: string }>(
    `select workspace.public_id
     from workspace_members member
     join workspaces workspace on workspace.id = member.workspace_id
     where member.user_id = $1 and workspace.public_id = $2
     limit 1`,
    [viewer.userId, workspacePublicId],
  );
  if (!membership.rows[0]) {
    return NextResponse.json({ error: "工作区不存在或无权访问" }, { status: 404 });
  }

  const response = NextResponse.json({ workspacePublicId });
  response.cookies.set(ACTIVE_WORKSPACE_COOKIE, workspacePublicId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
