import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { listContextMemoryPolicies } from "@/lib/context-system";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ policies: await listContextMemoryPolicies(viewer) });
}
