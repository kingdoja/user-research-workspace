import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { updateCollaborationPublicationStatus } from "@/lib/platform-control";

const inputSchema = z.object({ status: z.enum(["submitted", "accepted", "rejected", "revoked"]) });

export async function PATCH(request: Request, context: RouteContext<"/api/platform/collaboration/publications/[publicId]/status">) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "状态无效" }, { status: 400 });
  const { publicId } = await context.params;
  const result = await updateCollaborationPublicationStatus(viewer, publicId, parsed.data.status);
  if (result === "forbidden") return NextResponse.json({ error: "无权处理发布包" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "发布包不存在" }, { status: 404 });
  if (result === "invalid_transition") return NextResponse.json({ error: "当前状态不允许执行该操作" }, { status: 409 });
  return NextResponse.json(result);
}
