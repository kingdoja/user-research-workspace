import { NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { getOpenAIProviderStatus } from "@/lib/openai-provider";

export const dynamic = "force-dynamic";

export async function GET() {
  const provider = getOpenAIProviderStatus();
  const requireWorker = process.env.HEALTH_REQUIRE_WORKER === "1"
    || (process.env.NODE_ENV === "production" && process.env.HEALTH_REQUIRE_WORKER !== "0");
  const checks = {
    database: { status: "unavailable" as "ok" | "unavailable", latencyMs: 0 },
    migrations: { status: "unknown" as "ok" | "missing" | "unknown" },
    provider: { status: provider.configured ? "configured" as const : "missing" as const },
    worker: { status: "unknown" as "ok" | "stale" | "missing" | "unknown", required: requireWorker },
  };

  try {
    const startedAt = performance.now();
    const database = await getDatabase();
    const schema = await database.query<{
      core_ready: boolean;
      heartbeat_ready: boolean;
      rate_limit_ready: boolean;
    }>(
      `select to_regclass('public.agent_runs') is not null as core_ready,
              to_regclass('public.runtime_worker_heartbeats') is not null as heartbeat_ready,
              to_regclass('public.request_rate_limits') is not null as rate_limit_ready`,
    );
    checks.database = { status: "ok", latencyMs: Math.round(performance.now() - startedAt) };
    checks.migrations.status = schema.rows[0]?.core_ready
      && schema.rows[0]?.heartbeat_ready
      && schema.rows[0]?.rate_limit_ready ? "ok" : "missing";

    if (schema.rows[0]?.heartbeat_ready) {
      const heartbeat = await database.query<{ recent: boolean; exists: boolean }>(
        `select coalesce(bool_or(heartbeat_at > now() - interval '45 seconds'), false) as recent,
                count(*) > 0 as exists
         from runtime_worker_heartbeats`,
      );
      checks.worker.status = heartbeat.rows[0]?.recent
        ? "ok"
        : heartbeat.rows[0]?.exists ? "stale" : "missing";
    }
  } catch (error) {
    console.error("Readiness database check failed", error);
  }

  const ready = checks.database.status === "ok"
    && checks.migrations.status === "ok"
    && checks.provider.status === "configured"
    && (!checks.worker.required || checks.worker.status === "ok");
  return NextResponse.json({
    status: ready ? "ready" : "unready",
    service: "cognara-ai",
    timestamp: new Date().toISOString(),
    checks,
  }, {
    status: ready ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
