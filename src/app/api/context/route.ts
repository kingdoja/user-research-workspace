import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import {
  contextAssetInputSchema,
  createContextAsset,
  listContextAssets,
} from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ assets: await listContextAssets(viewer) });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = contextAssetInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Context asset 无效" }, { status: 400 });
  const result = await createContextAsset(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权创建 Context" }, { status: 403 });
  if (result === "study_not_found") return NextResponse.json({ error: "绑定的研究不存在" }, { status: 404 });
  return NextResponse.json(result, { status: 201 });
}
