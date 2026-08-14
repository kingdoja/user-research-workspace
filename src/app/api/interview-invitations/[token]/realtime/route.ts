import { NextResponse } from "next/server";
import { startRealtimeInterviewSchema } from "@/lib/interview-schema";
import { startRealtimeInterview } from "@/lib/realtime-interviews";
import { isSameOriginRequest } from "@/lib/request-security";

export const maxDuration = 120;

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const parsed = startRealtimeInterviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "参与者信息无效" }, { status: 400 });
  const { token } = await params;
  const result = await startRealtimeInterview(token, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "邀请链接无效或已过期" }, { status: 404 });
  if (result === "no_questions") return NextResponse.json({ error: "该访谈尚未配置问题" }, { status: 409 });
  if (result === "provider_missing") return NextResponse.json({ error: "实时访谈 Agent 尚未配置模型服务" }, { status: 503 });
  return NextResponse.json(result, { status: 201 });
}
