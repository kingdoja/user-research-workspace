import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import {
  contextReviewInputSchema,
  contextTombstoneInputSchema,
  reviewContextAsset,
  tombstoneContextAsset,
} from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = contextReviewInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "审核请求无效" }, { status: 400 });
  const result = await reviewContextAsset(viewer, (await params).publicId, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "Context asset 不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "只有工作区管理员可以审核资产" }, { status: 403 });
  if (result === "tombstoned") return NextResponse.json({ error: "已下架资产不能审核" }, { status: 409 });
  if (result === "expired") return NextResponse.json({ error: "候选已过期，不能批准；请等待新研究提出替代版本" }, { status: 409 });
  return NextResponse.json(result);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = contextTombstoneInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "下架原因无效" }, { status: 400 });
  const result = await tombstoneContextAsset(viewer, (await params).publicId, parsed.data.reason);
  if (result === "not_found") return NextResponse.json({ error: "Context asset 不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "无权下架该 Context asset" }, { status: 403 });
  return NextResponse.json(result);
}
