import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import {
  apiKeyInputSchema,
  createWorkspaceApiKey,
  listWorkspaceApiKeys,
} from "@/lib/api-access";
import { isSameOriginRequest } from "@/lib/request-security";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (viewer.role !== "owner" && viewer.role !== "admin") {
    return NextResponse.json({ error: "只有管理员可以查看 API 密钥" }, { status: 403 });
  }
  return NextResponse.json({ apiKeys: await listWorkspaceApiKeys(viewer) });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = apiKeyInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "API 密钥配置无效" }, { status: 400 });
  }
  const result = await createWorkspaceApiKey(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以创建 API 密钥" }, { status: 403 });
  return NextResponse.json(result, { status: 201 });
}
