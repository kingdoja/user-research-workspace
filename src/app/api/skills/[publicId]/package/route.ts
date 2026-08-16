import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { exportWorkspaceSkillPackage } from "@/lib/skill-gateway";

export async function GET(_request: Request, context: { params: Promise<{ publicId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await exportWorkspaceSkillPackage(viewer, (await context.params).publicId);
  if (result === "not_found") return NextResponse.json({ error: "仅已审批的 .skill 包可导出" }, { status: 404 });
  if (result === "invalid_package") return NextResponse.json({ error: "已存 Skill 包不符合当前格式" }, { status: 409 });
  return NextResponse.json(result, {
    headers: { "content-disposition": `attachment; filename="${result.manifest.slug}.skill"` },
  });
}
