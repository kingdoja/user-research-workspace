import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";
import { createStrategyExperiment, listStrategyExperiments } from "@/lib/runtime-control";

const experimentSchema = z.object({
  experimentKey: z.string().trim().min(2).max(80).regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).default(""),
  workflowType: z.enum(["realtime_agent", "batch_research"]).default("batch_research"),
  variants: z.array(z.object({
    variantKey: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().trim().min(1).max(120),
    strategyVersion: z.string().trim().min(1).max(80),
    weight: z.number().int().min(1).max(10000),
    config: z.object({
      taskConcurrency: z.number().int().min(1).max(8).optional(),
      taskTimeoutSeconds: z.number().int().min(15).max(3600).optional(),
      runTimeoutSeconds: z.number().int().min(30).max(14400).optional(),
      instructionSuffix: z.string().trim().max(2000).optional(),
    }).passthrough().default({}),
  })).min(2).max(8),
}).superRefine((input, context) => {
  if (new Set(input.variants.map((variant) => variant.variantKey)).size !== input.variants.length) {
    context.addIssue({ code: "custom", path: ["variants"], message: "实验 variantKey 不能重复" });
  }
});

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ experiments: await listStrategyExperiments(viewer) });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = experimentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "实验配置无效" }, { status: 400 });
  const result = await createStrategyExperiment(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以创建实验" }, { status: 403 });
  if (result === "conflict") return NextResponse.json({ error: "实验 key 已存在" }, { status: 409 });
  return NextResponse.json(result, { status: 201 });
}
