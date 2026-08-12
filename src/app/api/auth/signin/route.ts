import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAccount } from "@/lib/auth";
import { isSameOriginRequest, safeCallbackPath } from "@/lib/request-security";

const signinSchema = z.object({
  email: z.email("请输入有效的邮箱地址").max(320),
  password: z.string().min(1, "请输入密码").max(128),
  callbackUrl: z.string().optional(),
});

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }

  const parsed = signinSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "登录信息无效" },
      { status: 400 },
    );
  }

  const authenticated = await authenticateAccount(parsed.data.email, parsed.data.password);

  if (!authenticated) {
    return NextResponse.json({ error: "邮箱或密码不正确" }, { status: 401 });
  }

  return NextResponse.json({ redirectTo: safeCallbackPath(parsed.data.callbackUrl) });
}
