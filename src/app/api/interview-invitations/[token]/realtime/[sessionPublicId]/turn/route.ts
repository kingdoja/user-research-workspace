import { NextResponse } from "next/server";
import { realtimeInterviewTurnSchema } from "@/lib/interview-schema";
import { submitRealtimeInterviewTurn } from "@/lib/realtime-interviews";
import { isSameOriginRequest } from "@/lib/request-security";

export const maxDuration = 120;

export async function POST(request: Request, { params }: { params: Promise<{ token: string; sessionPublicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const parsed = realtimeInterviewTurnSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "访谈回答无效" }, { status: 400 });
  const resumeToken = request.headers.get("x-interview-resume-token")?.trim() ?? "";
  const { token, sessionPublicId } = await params;
  const result = await submitRealtimeInterviewTurn(token, sessionPublicId, resumeToken, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "实时访谈会话不存在或无法恢复" }, { status: 404 });
  if (result === "expired") return NextResponse.json({ error: "实时访谈已超过会话时限" }, { status: 410 });
  if (result === "pending_turn") return NextResponse.json({ error: "上一轮仍在生成，请稍后重试" }, { status: 409 });
  if ("provider_error" in result) return NextResponse.json({ error: result.provider_error, retryable: true }, { status: 502 });
  if ("terminal" in result) return NextResponse.json({ state: result.terminal });
  return NextResponse.json({ state: result });
}
