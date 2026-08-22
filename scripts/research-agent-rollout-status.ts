import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { getResearchAgentVariantRolloutReport } from "../src/lib/research-agent-rollout-report";

loadEnvConfig(process.cwd());

const workspaceId = process.argv[2] ?? "28";
const experimentKey = process.argv[3] ?? "research-agent-shadow-v1";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new Client({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
});

async function main() {
  await database.connect();
  try {
    const experimentResult = await database.query<{
      id: string;
      public_id: string;
      experiment_key: string;
      name: string;
      status: string;
      workflow_type: string;
    }>(
      `select id::text, public_id, experiment_key, name, status, workflow_type
       from strategy_experiments where workspace_id = $1 and experiment_key = $2`,
      [workspaceId, experimentKey],
    );
    const experiment = experimentResult.rows[0];
    if (!experiment) throw new Error("RESEARCH_AGENT_EXPERIMENT_NOT_FOUND");
    const variantsResult = await database.query<{
      variant_key: string;
      name: string;
      strategy_version: string;
      weight: number;
      config: Record<string, unknown> | string;
    }>(
      `select variant_key, name, strategy_version, weight, config
       from strategy_variants where experiment_id = $1 order by id`,
      [experiment.id],
    );
    const variants = await Promise.all(variantsResult.rows.map(async (variant) => {
      const config = typeof variant.config === "string" ? JSON.parse(variant.config) as Record<string, unknown> : variant.config;
      const report = await getResearchAgentVariantRolloutReport({
        queryable: database,
        workspaceId,
        variantKey: variant.variant_key,
        strategyVersion: variant.strategy_version,
        strategyConfig: config,
      });
      const metrics = report.shadow.runs.concat(report.active.runs).map((row) => row.metrics);
      return {
        variantKey: variant.variant_key,
        name: variant.name,
        strategyVersion: variant.strategy_version,
        weight: variant.weight,
        controllerMode: config.agentControllerMode ?? "off",
        allowedTemplates: config.agentControllerAllowedTemplates ?? null,
        sampleCount: report.workerSampleCount,
        productionWorkerSampleCount: report.workerSampleCount,
        localProbeCount: report.localProbeCount,
        quality: report.shadow.quality,
        shadow: report.shadow,
        active: report.active,
        automaticFallbacks: report.automaticFallbacks,
        metrics,
      };
    }));
    console.log(JSON.stringify({
      workspaceId,
      experiment: {
        publicId: experiment.public_id,
        experimentKey: experiment.experiment_key,
        name: experiment.name,
        status: experiment.status,
        workflowType: experiment.workflow_type,
      },
      variants,
    }, null, 2));
  } finally {
    await database.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
