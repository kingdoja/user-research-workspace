import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { createRoutingPolicyVersion, listRoutingControl } from "@/lib/platform-control";

const optionalPositiveInteger = z.number().int().positive().nullable();
const routeSchema = z.object({
  routeKey: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/),
  providerName: z.string().trim().min(2).max(80),
  model: z.string().trim().min(1).max(160),
  protocol: z.enum(["responses", "chat_completions"]),
  priority: z.number().int().min(1).max(10000),
  weight: z.number().int().min(1).max(10000),
  qualityTier: z.enum(["basic", "standard", "high", "premium"]),
  expectedLatencyMs: optionalPositiveInteger,
  inputPriceMicrosPerMillion: z.number().int().min(0),
  outputPriceMicrosPerMillion: z.number().int().min(0),
  pricingSource: z.string().trim().min(2).max(240),
  pricingEffectiveAt: z.iso.date(),
});

const inputSchema = z.object({
  policyKey: z.string().trim().min(2).max(80).regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(2).max(120),
  stage: z.enum(["plan", "research", "reasoning", "report", "judge", "followup"]),
  description: z.string().trim().max(1200),
  selectionMode: z.enum(["weighted", "priority"]),
  maxEstimatedCostMicros: z.number().int().min(0).nullable(),
  maxLatencyMs: optionalPositiveInteger,
  minimumQualityTier: z.enum(["basic", "standard", "high", "premium"]),
  estimatedInputTokens: z.number().int().min(1).max(10000000),
  estimatedOutputTokens: z.number().int().min(1).max(10000000),
  changeNote: z.string().trim().max(500),
  routes: z.array(routeSchema).min(1).max(12),
}).superRefine((input, context) => {
  if (new Set(input.routes.map((route) => route.routeKey)).size !== input.routes.length) {
    context.addIssue({ code: "custom", path: ["routes"], message: "路由 key 不能重复" });
  }
});

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json(await listRoutingControl(viewer));
}

export async function POST(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "路由策略参数无效", issues: parsed.error.issues }, { status: 400 });
  const result = await createRoutingPolicyVersion(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "只有工作区管理员可以管理路由策略" }, { status: 403 });
  if (result === "stage_conflict") return NextResponse.json({ error: "同一策略 key 不能更改阶段" }, { status: 409 });
  return NextResponse.json(result, { status: 201 });
}
