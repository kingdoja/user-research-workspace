import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import {
  contextBehaviorObservationInputSchema,
  contextBehaviorObservationReviewSchema,
  contextMemoryPromotionSchema,
  createContextBehaviorObservation,
  getContextMemoryDetail,
  promoteContextMemory,
  reviewContextBehaviorObservation,
} from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await getContextMemoryDetail(viewer, (await params).publicId);
  if (result === "not_found") return NextResponse.json({ error: "Memory 不存在或无权查看" }, { status: 404 });
  return NextResponse.json({ memory: result });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = contextBehaviorObservationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "行为观察无效" }, { status: 400 });
  const result = await createContextBehaviorObservation(viewer, (await params).publicId, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "Memory 不存在" }, { status: 404 });
  if (result === "source_not_found") return NextResponse.json({ error: "证据来源资产不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权添加行为观察" }, { status: 403 });
  if (result === "not_working_memory") return NextResponse.json({ error: "行为观察只能添加到 Working Memory" }, { status: 409 });
  if (result === "tombstoned") return NextResponse.json({ error: "已下架 Memory 不能添加观察" }, { status: 409 });
  if (result === "self_source") return NextResponse.json({ error: "Memory 不能作为自身的证据来源" }, { status: 409 });
  if (result === "duplicate") return NextResponse.json({ error: "该行为观察已存在" }, { status: 409 });
  return NextResponse.json(result, { status: 201 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const publicId = (await params).publicId;
  if (body?.action === "promote") {
    const parsed = contextMemoryPromotionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Memory 晋升请求无效" }, { status: 400 });
    const result = await promoteContextMemory(viewer, publicId, parsed.data);
    if (result === "not_found") return NextResponse.json({ error: "Memory 不存在" }, { status: 404 });
    if (result === "forbidden") return NextResponse.json({ error: "当前角色无权晋升 Memory" }, { status: 403 });
    if (result === "not_working_memory") return NextResponse.json({ error: "只有 Working Memory 可以晋升" }, { status: 409 });
    if (result === "memory_not_approved") return NextResponse.json({ error: "Working Memory 本身需要先完成审核" }, { status: 409 });
    if (result.status === "insufficient_observations") {
      return NextResponse.json({ error: `至少需要 ${result.required} 条已审核且未过期的行为观察`, ...result }, { status: 409 });
    }
    return NextResponse.json(result);
  }
  const parsed = contextBehaviorObservationReviewSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "观察审核请求无效" }, { status: 400 });
  const result = await reviewContextBehaviorObservation(viewer, publicId, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "Memory 不存在" }, { status: 404 });
  if (result === "observation_not_found") return NextResponse.json({ error: "行为观察不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "只有工作区管理员可以审核观察" }, { status: 403 });
  return NextResponse.json(result);
}
