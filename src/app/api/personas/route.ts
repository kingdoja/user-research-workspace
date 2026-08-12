import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { createPersona, listPersonas } from "@/lib/studies";

export const personaInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  archetype: z.string().trim().min(2).max(80),
  age: z.number().int().min(18).max(90),
  city: z.string().trim().min(2).max(80),
  occupation: z.string().trim().min(2).max(120),
  commute: z.string().trim().min(5).max(500),
  budget: z.string().trim().min(2).max(120),
  currentSituation: z.string().trim().min(10).max(1000),
  goals: z.array(z.string().trim().min(2).max(200)).min(2).max(6),
  painPoints: z.array(z.string().trim().min(2).max(200)).min(2).max(6),
  decisionStyle: z.string().trim().min(8).max(500),
  tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  visibility: z.enum(["private", "workspace"]),
  addToPanelPublicIds: z.array(z.string().trim().min(8).max(120)).max(20),
});

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json(await listPersonas(viewer));
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
