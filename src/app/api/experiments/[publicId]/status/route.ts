import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { updateStrategyExperimentStatus } from "@/lib/runtime-control";

const statusSchema = z.object({ status: z.enum(["active", "paused", "completed"]) });

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = statusSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "实验状态无效" }, { status: 400 });
  const result = await updateStrategyExperimentStatus(viewer, (await context.params).publicId, parsed.data.status);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以修改实验" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "实验不存在" }, { status: 404 });
  return NextResponse.json({ status: parsed.data.status });
}
