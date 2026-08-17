import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { activateRoutingPolicyVersion } from "@/lib/platform-control";

export async function POST(_request: Request, context: RouteContext<"/api/platform/routing/versions/[publicId]/activate">) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { publicId } = await context.params;
  const result = await activateRoutingPolicyVersion(viewer, publicId);
  if (result === "forbidden") return NextResponse.json({ error: "只有工作区管理员可以发布路由策略" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "策略版本不存在" }, { status: 404 });
  if (result === "routes_missing") return NextResponse.json({ error: "策略版本没有可用路由" }, { status: 409 });
  return NextResponse.json(result);
}
