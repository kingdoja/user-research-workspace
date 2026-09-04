import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { reviseStudyPlan } from "@/lib/studies";
import type { StudyMethod } from "@/lib/research-types";

const methods = ["Interview Chat", "Discussion Chat", "Scout Agent", "Fast Insight"] as const satisfies readonly StudyMethod[];
const planSchema = z.object({
  framework: z.string().trim().min(2).max(120),
  methods: z.array(z.enum(methods)).max(4),
  audience: z.string().trim().min(2).max(240),
  source: z.string().trim().min(2).max(160),
  personaCount: z.number().int().min(1).max(20),
  estimatedDurationMinutes: z.number().int().min(30).max(4320),
  estimatedTokens: z.number().int().min(10000).max(250000),
  rationale: z.string().trim().min(20).max(1600),
  feedback: z.string().trim().max(1200).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ publicId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = planSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请检查计划字段是否完整" }, { status: 400 });

  const result = await reviseStudyPlan(viewer, (await context.params).publicId, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "研究项目不存在" }, { status: 404 });
  if (result === "already_confirmed") return NextResponse.json({ error: "计划已确认，不能修改" }, { status: 409 });
  return NextResponse.json({ status: result });
}
