import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const workerId = process.env.RESEARCH_WORKER_ID?.trim() || `research-${randomUUID()}`;
const pollInterval = Number(process.env.RESEARCH_WORKER_POLL_MS ?? 2000);
const once = process.argv.includes("--once");
const targetedAgentRunPublicId = process.env.AGENT_RUN_PUBLIC_ID?.trim() || undefined;
const agentOnly = process.env.AGENT_WORKER_AGENT_ONLY === "1" || process.argv.includes("--agent-only");
const versionOnly = process.argv.includes("--version");

async function loadHarness() {
  return import("../src/lib/research-harness.ts");
}

async function loadInterviews() {
  return import("../src/lib/interviews.ts");
}

async function loadAgent() {
  return import("../src/lib/universal-agent.ts");
}

async function loadAgentProvider() {
  return import("../src/lib/openai-provider.ts");
}

async function runQueue(processQueue) {
  do {
    const processed = await processQueue();
    if (once) return;
    if (processed === 0) await new Promise((resolve) => setTimeout(resolve, pollInterval));
  } while (true);
}

const [{ processStudyJobQueue }, { processInterviewJobQueue }, { processAgentRunQueue }, { UNIVERSAL_AGENT_PROMPT_VERSION }] = await Promise.all([
  loadHarness(),
  loadInterviews(),
  loadAgent(),
  loadAgentProvider(),
]);
const maxJobs = once ? 1 : 5;

let workerHeartbeat;
if (!versionOnly) {
  const { getDatabase } = await import("../src/lib/db.ts");
  const database = await getDatabase();
  const writeHeartbeat = () => database.query(
    `with stale as (
       delete from runtime_worker_heartbeats
       where heartbeat_at < now() - interval '7 days'
       returning worker_id
     )
     insert into runtime_worker_heartbeats (worker_id, worker_kind, status, metadata, started_at, heartbeat_at)
     values ($1, 'research-worker', 'running', $2::jsonb, now(), now())
     on conflict (worker_id) do update set status = 'running', metadata = excluded.metadata,
       heartbeat_at = now()`,
    [workerId, JSON.stringify({ agentOnly })],
  );
  await writeHeartbeat();
  workerHeartbeat = setInterval(() => {
    writeHeartbeat().catch((error) => console.error(JSON.stringify({
      event: "research_worker_heartbeat_failed",
      workerId,
      message: error instanceof Error ? error.message : "WORKER_HEARTBEAT_FAILED",
    })));
  }, 15_000);
  workerHeartbeat.unref();
}

console.log(JSON.stringify({
  event: "research_worker_started",
  workerId,
  agentPromptVersion: UNIVERSAL_AGENT_PROMPT_VERSION,
  targetedAgentRunPublicId: targetedAgentRunPublicId ?? null,
  agentOnly,
  versionOnly,
  once,
}));

if (!versionOnly && !agentOnly) {
  const { assertConfiguredSourceRawStorageReady } = await import("../src/lib/source-raw-storage.ts");
  try {
    const storageStatus = await assertConfiguredSourceRawStorageReady();
    console.log(JSON.stringify({ event: "research_worker_source_storage_ready", ...storageStatus }));
  } catch (error) {
    // Raw source storage is an optimization for large immutable bodies. The
    // connector has a bounded inline fallback, so a local MinIO outage must
    // not prevent the worker from processing research jobs.
    console.warn(JSON.stringify({
      event: "research_worker_dependency_degraded",
      dependency: "source_object_storage",
      fallback: "inline_bounded",
      message: error instanceof Error ? error.message : "SOURCE_OBJECT_STORAGE_UNAVAILABLE",
    }));
  }
}

if (!versionOnly) {
  const queues = agentOnly
    ? [runQueue(() => processAgentRunQueue({ workerId: `${workerId}:agent`, maxRuns: maxJobs, runPublicId: targetedAgentRunPublicId }))]
    : [
        runQueue(() => processStudyJobQueue({ workerId: `${workerId}:study`, maxJobs })),
        runQueue(() => processInterviewJobQueue({ workerId: `${workerId}:interview`, maxJobs })),
        runQueue(() => processAgentRunQueue({ workerId: `${workerId}:agent`, maxRuns: maxJobs, runPublicId: targetedAgentRunPublicId })),
      ];

  await Promise.all(queues);
}

if (once && !versionOnly) {
  const { closeDatabase } = await import("../src/lib/db.ts");
  if (workerHeartbeat) clearInterval(workerHeartbeat);
  await closeDatabase();
}
