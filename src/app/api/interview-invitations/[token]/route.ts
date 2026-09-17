import { NextResponse } from "next/server";
import { getPublicInterviewInvitation, submitPublicInterview } from "@/lib/interviews";
import { submitPublicInterviewSchema } from "@/lib/interview-schema";
import { checkRateLimit, isSameOriginRequest, rateLimitResponse } from "@/lib/request-security";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await getPublicInterviewInvitation(token);
  if (!invitation) return NextResponse.json({ error: "邀请链接无效或已过期" }, { status: 404 });
  return NextResponse.json({ invitation });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const rateLimit = await checkRateLimit(request, "public-interview-submit", { limit: 30, windowMs: 15 * 60_000 });
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfterSeconds);
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const parsed = submitPublicInterviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "访谈回答无效" }, { status: 400 });
  const { token } = await params;
  const result = await submitPublicInterview(token, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "邀请链接无效或已过期" }, { status: 404 });
  if (result === "invalid_answers") return NextResponse.json({ error: "请完成全部问题后提交" }, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}
