import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { contextSearchInputSchema, retrieveContext } from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = contextSearchInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "检索条件无效" }, { status: 400 });
  return NextResponse.json(await retrieveContext({
    workspaceId: viewer.workspaceId,
    userId: viewer.userId,
    query: parsed.data.query,
    assetTypes: parsed.data.assetTypes,
    scopes: parsed.data.scopes,
    purpose: parsed.data.purpose,
    limit: parsed.data.limit,
  }));
}
