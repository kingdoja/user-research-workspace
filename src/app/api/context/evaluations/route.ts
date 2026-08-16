import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import {
  contextEvaluationSetInputSchema,
  createContextEvaluationSet,
  listContextEvaluationSets,
} from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ evaluationSets: await listContextEvaluationSets(viewer) });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = contextEvaluationSetInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "评估集无效" }, { status: 400 });
  const result = await createContextEvaluationSet(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以创建检索评估集" }, { status: 403 });
  if (result === "chunk_not_authorized") {
    return NextResponse.json({ error: "期望 chunk 必须来自工作区已批准、已确认同意且已脱敏的真实研究样本当前版本" }, { status: 400 });
  }
  return NextResponse.json(result, { status: 201 });
}
