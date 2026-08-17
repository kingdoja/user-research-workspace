import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Client } from "pg";

const smokeName = process.argv[2] ?? "interview-metrics";
const allowedSmokes = new Map([
  ["experiment-comparison", { command: "pnpm", args: ["smoke:experiment-comparison"], confirmation: "EXPERIMENT_COMPARISON_SMOKE_CONFIRM" }],
  ["evidence-graph", { command: "pnpm", args: ["smoke:evidence-graph"], confirmation: "EVIDENCE_GRAPH_SMOKE_CONFIRM" }],
  ["reasoning-runtime", { command: "pnpm", args: ["smoke:reasoning-runtime"], confirmation: "REASONING_RUNTIME_SMOKE_CONFIRM" }],
  ["source-connector", { command: "pnpm", args: ["smoke:source-connector"], confirmation: "SOURCE_CONNECTOR_SMOKE_CONFIRM" }],
  ["social-connector", { command: "pnpm", args: ["smoke:social-connector"], confirmation: "SOCIAL_CONNECTOR_SMOKE_CONFIRM" }],
  ["task-recovery", { command: "pnpm", args: ["smoke:task-recovery"], confirmation: "TASK_RECOVERY_SMOKE_CONFIRM" }],
  ["interview-metrics", { command: "pnpm", args: ["smoke:interview-metrics"], confirmation: "INTERVIEW_METRICS_SMOKE_CONFIRM" }],
  ["context-hybrid", { command: "pnpm", args: ["smoke:context-hybrid"], confirmation: "CONTEXT_HYBRID_SMOKE_CONFIRM" }],
  ["context-asset-flywheel", { command: "pnpm", args: ["smoke:context-asset-flywheel"], confirmation: "CONTEXT_ASSET_FLYWHEEL_SMOKE_CONFIRM" }],
  ["context-memory-policy", { command: "pnpm", args: ["smoke:context-memory-policy"], confirmation: "CONTEXT_MEMORY_POLICY_SMOKE_CONFIRM" }],
  ["agent-eval-dynamic-context", { command: "pnpm", args: ["smoke:agent-eval-dynamic-context"], confirmation: "AGENT_EVAL_DYNAMIC_CONTEXT_SMOKE_CONFIRM" }],
  ["persona-evidence", { command: "pnpm", args: ["smoke:persona-evidence"], confirmation: "PERSONA_EVIDENCE_SMOKE_CONFIRM" }],
  ["plan-version-replay", { command: "pnpm", args: ["smoke:plan-version-replay"], confirmation: "PLAN_VERSION_REPLAY_SMOKE_CONFIRM" }],
  ["skill-executor", { command: "pnpm", args: ["smoke:skill-executor"], confirmation: "SKILL_EXECUTOR_SMOKE_CONFIRM" }],
  ["skill-package-governance", { command: "pnpm", args: ["smoke:skill-package-governance"], confirmation: "SKILL_PACKAGE_GOVERNANCE_SMOKE_CONFIRM" }],
  ["intent-workflow-contract", { command: "pnpm", args: ["smoke:intent-workflow-contract"], confirmation: "INTENT_WORKFLOW_CONTRACT_SMOKE_CONFIRM" }],
  ["market-insight-workflow", { command: "pnpm", args: ["smoke:market-insight-workflow"], confirmation: "MARKET_INSIGHT_WORKFLOW_SMOKE_CONFIRM" }],
  ["api-access", { command: "pnpm", args: ["smoke:api-access"], confirmation: "API_ACCESS_SMOKE_CONFIRM" }],
  ["platform-control", { command: "pnpm", args: ["smoke:platform-control"], confirmation: "PLATFORM_CONTROL_SMOKE_CONFIRM" }],
]);
const smoke = allowedSmokes.get(smokeName);
if (!smoke) throw new Error(`Unsupported isolated smoke: ${smokeName}`);

const sourceUrlValue = process.env.LOCAL_SMOKE_DATABASE_URL;
if (!sourceUrlValue) {
  throw new Error("Set LOCAL_SMOKE_DATABASE_URL to a localhost PostgreSQL URL.");
}
const sourceUrl = new URL(sourceUrlValue);
if (!["localhost", "127.0.0.1"].includes(sourceUrl.hostname)) {
  throw new Error("Set LOCAL_SMOKE_DATABASE_URL to a localhost PostgreSQL URL.");
}

const databaseName = `atypica_smoke_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const smokeUrl = new URL(sourceUrl);
smokeUrl.pathname = `/${databaseName}`;

function runSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(smoke.command, smoke.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: smokeUrl.toString(),
        DATABASE_SSL_MODE: "disable",
        [smoke.confirmation]: "1",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${smokeName} exited with ${code}`)));
  });
}

async function main() {
  const admin = new Client({ connectionString: adminUrl.toString(), ssl: false });
  await admin.connect();
  try {
    await admin.query(`create database ${databaseName}`);
    const database = new Client({ connectionString: smokeUrl.toString(), ssl: false });
    await database.connect();
    try {
      await database.query(`
        create schema auth;
        do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
        create function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create table auth.users (
          id uuid primary key,
          email text not null,
          raw_user_meta_data jsonb not null default '{}'::jsonb
        );
        create schema storage;
        create table storage.buckets (
          id text primary key,
          name text not null,
          public boolean not null default false,
          file_size_limit bigint,
          allowed_mime_types text[]
        );
        create table storage.objects (
          id bigint generated always as identity primary key,
          bucket_id text not null references storage.buckets(id) on delete cascade,
          name text not null
        );
        create function storage.foldername(path text) returns text[] language sql immutable as
          $$ select string_to_array(path, '/') $$;
      `);
      const migrations = (await readdir("supabase/migrations"))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const migration of migrations) {
        await database.query(await readFile(`supabase/migrations/${migration}`, "utf8"));
      }
    } finally {
      await database.end();
    }
    await runSmoke();
    console.log(JSON.stringify({ smoke: smokeName, migrationsApplied: true, isolated: true }));
  } finally {
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`drop database if exists ${databaseName}`);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
