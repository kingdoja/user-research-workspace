import { NextResponse } from "next/server";
import { cancelRealtimeInterview, getRealtimeInterviewState } from "@/lib/realtime-interviews";
import { isSameOriginRequest } from "@/lib/request-security";

type Context = { params: Promise<{ token: string; sessionPublicId: string }> };

function resumeToken(request: Request) {
  return request.headers.get("x-interview-resume-token")?.trim() ?? "";
}

export async function GET(request: Request, { params }: Context) {
  const { token, sessionPublicId } = await params;
  const result = await getRealtimeInterviewState(token, sessionPublicId, resumeToken(request));
  if (result === "not_found") return NextResponse.json({ error: "实时访谈会话不存在或无法恢复" }, { status: 404 });
  return NextResponse.json({ state: result });
}

export async function DELETE(request: Request, { params }: Context) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const { token, sessionPublicId } = await params;
  const result = await cancelRealtimeInterview(token, sessionPublicId, resumeToken(request));
  if (result === "not_found") return NextResponse.json({ error: "实时访谈会话不存在或无法恢复" }, { status: 404 });
  return NextResponse.json({ state: result });
}
