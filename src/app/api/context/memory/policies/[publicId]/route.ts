import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { contextMemoryPolicyInputSchema, updateContextMemoryPolicy } from "@/lib/context-system";
import { isSameOriginRequest } from "@/lib/request-security";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = contextMemoryPolicyInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Memory policy 无效" }, { status: 400 });
  const result = await updateContextMemoryPolicy(viewer, (await params).publicId, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "Memory policy 不存在或已被替代" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "只有工作区管理员可以修改 Memory policy" }, { status: 403 });
  return NextResponse.json(result);
}
