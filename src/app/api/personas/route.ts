import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { createPersona, listPersonas } from "@/lib/studies";
import { personaInputSchema } from "@/lib/persona-input-schema";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json(await listPersonas(viewer, { includeInactive: true }));
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = personaInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Persona 信息无效" }, { status: 400 });
  try {
    const publicId = await createPersona(viewer, parsed.data);
    return NextResponse.json({ publicId }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "PANEL_NOT_FOUND") return NextResponse.json({ error: "所选 Panel 不存在" }, { status: 404 });
    throw error;
  }
}
