import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { createAgentThread, createAgentThreadInputSchema } from "@/lib/universal-agent";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = createAgentThreadInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "会话标题无效" }, { status: 400 });
  const result = await createAgentThread(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权创建 Agent 会话" }, { status: 403 });
  return NextResponse.json(result, { status: 201 });
}
