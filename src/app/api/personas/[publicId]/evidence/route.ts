import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import {
  getPersonaEvidence,
  personaRetentionInputSchema,
  updatePersonaRetention,
} from "@/lib/persona-evidence";
import { isSameOriginRequest } from "@/lib/request-security";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const result = await getPersonaEvidence(viewer, (await params).publicId);
  if (result === "not_found") return NextResponse.json({ error: "Persona 不存在" }, { status: 404 });
  return NextResponse.json(result);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = personaRetentionInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Persona 保留策略无效" }, { status: 400 });
  const result = await updatePersonaRetention(viewer, (await params).publicId, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "Persona 不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "没有权限治理该 Persona" }, { status: 403 });
  if (result === "invalid_expiry") return NextResponse.json({ error: "有效期必须晚于当前时间" }, { status: 400 });
  return NextResponse.json(result);
}
