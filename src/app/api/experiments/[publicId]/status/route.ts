import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { isSameOriginRequest } from "@/lib/request-security";
import { assessResearchAgentRolloutQuality } from "@/lib/research-agent-controller";
import { updateStrategyExperimentStatus } from "@/lib/runtime-control";

const statusSchema = z.object({ status: z.enum(["active", "paused", "completed"]) });

export async function GET(
  _request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (viewer.role !== "owner" && viewer.role !== "admin") {
    return NextResponse.json({ error: "只有管理员可以查看实验灰度状态" }, { status: 403 });
  }
  const publicId = (await context.params).publicId;
  const database = await getDatabase();
  const experiment = await database.query<{
    id: string;
    public_id: string;
    experiment_key: string;
    name: string;
    status: string;
    workflow_type: string;
  }>(
    `select id::text, public_id, experiment_key, name, status, workflow_type
     from strategy_experiments
     where public_id = $1 and workspace_id = $2`,
    [publicId, viewer.workspaceId],
  );
  const row = experiment.rows[0];
  if (!row) return NextResponse.json({ error: "实验不存在" }, { status: 404 });
  const variants = await database.query<{
    variant_key: string;
    name: string;
    strategy_version: string;
    weight: number;
    config: Record<string, unknown> | string;
  }>(
    `select variant_key, name, strategy_version, weight, config
     from strategy_variants where experiment_id = $1 order by id`,
    [row.id],
  );
  const variantStatuses = await Promise.all(variants.rows.map(async (variant) => {
    const config = typeof variant.config === "string" ? JSON.parse(variant.config) as Record<string, unknown> : variant.config;
    const minRunsValue = Number(config.agentControllerShadowMinRuns ?? 3);
    const limit = Number.isFinite(minRunsValue) ? Math.max(1, Math.min(20, Math.round(minRunsValue))) : 3;
    const trajectory = await database.query<{ metrics: Record<string, unknown> | string }>(
      `select evaluation.metrics
       from research_agent_trajectory_evaluations evaluation
       join study_runs run on run.id = evaluation.run_id
       where evaluation.workspace_id = $1
         and run.strategy_key = $2
         and run.strategy_version = $3
         and evaluation.evaluator_version = 'research-agent-trajectory-v1'
       order by evaluation.created_at desc, evaluation.id desc
       limit $4`,
      [viewer.workspaceId, variant.variant_key, variant.strategy_version, limit],
    );
    const metrics = trajectory.rows.map((item) => typeof item.metrics === "string" ? JSON.parse(item.metrics) as Record<string, unknown> : item.metrics);
    const quality = assessResearchAgentRolloutQuality({ metrics, strategyConfig: config });
    return {
      variantKey: variant.variant_key,
      name: variant.name,
      strategyVersion: variant.strategy_version,
      weight: variant.weight,
      controllerMode: typeof config.agentControllerMode === "string" ? config.agentControllerMode : "off",
      allowedTemplates: Array.isArray(config.agentControllerAllowedTemplates) ? config.agentControllerAllowedTemplates : null,
      sampleCount: metrics.length,
      quality,
      metrics,
    };
  }));
  return NextResponse.json({
    experiment: {
      publicId: row.public_id,
      experimentKey: row.experiment_key,
      name: row.name,
      status: row.status,
      workflowType: row.workflow_type,
    },
    variants: variantStatuses,
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = statusSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "实验状态无效" }, { status: 400 });
  const result = await updateStrategyExperimentStatus(viewer, (await context.params).publicId, parsed.data.status);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以修改实验" }, { status: 403 });
  if (result === "not_found") return NextResponse.json({ error: "实验不存在" }, { status: 404 });
  return NextResponse.json({ status: parsed.data.status });
}
