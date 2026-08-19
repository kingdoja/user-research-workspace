import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { deletePersona, updatePersona } from "@/lib/studies";
import { personaInputSchema } from "@/lib/persona-input-schema";

export async function PATCH(request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = personaInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Persona 信息无效" }, { status: 400 });
  try {
    const result = await updatePersona(viewer, (await params).publicId, parsed.data);
    if (result === "not_found") return NextResponse.json({ error: "Persona 不存在" }, { status: 404 });
    if (result === "forbidden") return NextResponse.json({ error: "没有权限编辑该 Persona" }, { status: 403 });
    return NextResponse.json({ updated: true });
  } catch (error) {
    if (error instanceof Error && error.message === "PANEL_NOT_FOUND") return NextResponse.json({ error: "所选 Panel 不存在" }, { status: 404 });
    throw error;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await deletePersona(viewer, (await params).publicId);
  if (result === "not_found") return NextResponse.json({ error: "Persona 不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "没有权限删除该 Persona" }, { status: 403 });
  if (result === "in_use") return NextResponse.json({ error: "该 Persona 仍被 Panel 或模拟访谈使用，暂时不能删除" }, { status: 409 });
  return NextResponse.json({ deleted: true });
}
