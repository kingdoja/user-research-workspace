import { NextResponse } from "next/server";
import { z } from "zod";
import { createAccount } from "@/lib/auth";
import { checkRateLimit, isSameOriginRequest, rateLimitResponse, safeCallbackPath } from "@/lib/request-security";

const signupSchema = z.object({
  name: z.string().trim().min(2, "请输入至少 2 个字符的姓名").max(80),
  email: z.email("请输入有效的邮箱地址").max(320),
  password: z.string().min(8, "密码至少需要 8 个字符").max(128),
  callbackUrl: z.string().optional(),
});

export async function POST(request: Request) {
  const rateLimit = await checkRateLimit(request, "auth-signup", { limit: 5, windowMs: 60 * 60_000 });
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfterSeconds);
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }

  const parsed = signupSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "注册信息无效" },
      { status: 400 },
    );
  }

  try {
    const account = await createAccount(parsed.data);

    return NextResponse.json({
      redirectTo: account.requiresEmailConfirmation
        ? "/auth/signin?registered=check-email"
        : safeCallbackPath(parsed.data.callbackUrl),
      requiresEmailConfirmation: account.requiresEmailConfirmation,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      const knownErrors: Record<string, { message: string; status: number }> = {
        EMAIL_EXISTS: { message: "该邮箱已经注册", status: 409 },
        EMAIL_INVALID: { message: "该邮箱地址不可用于注册", status: 400 },
        EMAIL_RATE_LIMITED: { message: "注册请求过于频繁，请稍后再试", status: 429 },
        PASSWORD_WEAK: { message: "密码强度不足，请使用更复杂的密码", status: 400 },
      };
      const knownError = knownErrors[error.message];

      if (knownError) {
        return NextResponse.json({ error: knownError.message }, { status: knownError.status });
      }
    }

    console.error("Failed to create Supabase account", error);
    return NextResponse.json({ error: "暂时无法创建账号" }, { status: 500 });
  }
}
