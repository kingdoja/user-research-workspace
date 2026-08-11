import { NextResponse } from "next/server";
import { z } from "zod";
import { createLocalAccount, createSession } from "@/lib/auth";
import { isSameOriginRequest, safeCallbackPath } from "@/lib/request-security";

const signupSchema = z.object({
  name: z.string().trim().min(2, "请输入至少 2 个字符的姓名").max(80),
  email: z.email("请输入有效的邮箱地址").max(320),
  password: z.string().min(8, "密码至少需要 8 个字符").max(128),
  callbackUrl: z.string().optional(),
});

export async function POST(request: Request) {
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
    const account = await createLocalAccount(parsed.data);
    await createSession(account.userId);

    return NextResponse.json({ redirectTo: safeCallbackPath(parsed.data.callbackUrl) }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "EMAIL_EXISTS") {
      return NextResponse.json({ error: "该邮箱已经注册" }, { status: 409 });
    }

    console.error("Failed to create local account", error);
    return NextResponse.json({ error: "暂时无法创建账号" }, { status: 500 });
  }
}
