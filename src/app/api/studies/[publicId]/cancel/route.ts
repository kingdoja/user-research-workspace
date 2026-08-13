import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { cancelStudyRun } from "@/lib/research-harness";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await cancelStudyRun(viewer, (await context.params).publicId);
  if (result === "not_found") return NextResponse.json({ error: "研究项目不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "当前角色无权取消研究" }, { status: 403 });
  if (result === "not_running") return NextResponse.json({ error: "当前没有可取消的运行" }, { status: 409 });
  return NextResponse.json({ status: result }, { status: result === "requested" ? 202 : 200 });
}
