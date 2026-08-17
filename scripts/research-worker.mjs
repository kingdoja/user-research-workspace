import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const workerId = process.env.RESEARCH_WORKER_ID?.trim() || `research-${randomUUID()}`;
const pollInterval = Number(process.env.RESEARCH_WORKER_POLL_MS ?? 2000);
const once = process.argv.includes("--once");

async function loadHarness() {
  return import("../src/lib/research-harness.ts");
}

async function loadInterviews() {
  return import("../src/lib/interviews.ts");
}

async function loadAgent() {
  return import("../src/lib/universal-agent.ts");
}

async function runQueue(processQueue) {
  do {
    const processed = await processQueue();
    if (once) return;
    if (processed === 0) await new Promise((resolve) => setTimeout(resolve, pollInterval));
  } while (true);
}

const [{ processStudyJobQueue }, { processInterviewJobQueue }, { processAgentRunQueue }] = await Promise.all([
  loadHarness(),
  loadInterviews(),
  loadAgent(),
]);
const maxJobs = once ? 1 : 5;

await Promise.all([
  runQueue(() => processStudyJobQueue({ workerId: `${workerId}:study`, maxJobs })),
  runQueue(() => processInterviewJobQueue({ workerId: `${workerId}:interview`, maxJobs })),
  runQueue(() => processAgentRunQueue({ workerId: `${workerId}:agent`, maxRuns: maxJobs })),
]);

if (once) {
  const { closeDatabase } = await import("../src/lib/db.ts");
  await closeDatabase();
}
