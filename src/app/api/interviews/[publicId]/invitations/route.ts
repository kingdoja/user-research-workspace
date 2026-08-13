import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { createInterviewInvitation } from "@/lib/interviews";
import { createInterviewInvitationSchema } from "@/lib/interview-schema";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = createInterviewInvitationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "邀请有效期无效" }, { status: 400 });
  const { publicId } = await params;
  const result = await createInterviewInvitation(viewer, publicId, parsed.data.durationDays);
  if (result === "forbidden") return NextResponse.json({ error: "没有权限创建邀请" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "访谈项目不存在" }, { status: 404 });
  return NextResponse.json(result, { status: 201 });
}
