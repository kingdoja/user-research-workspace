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

async function poll() {
  const [{ processStudyJobQueue }, { processInterviewJobQueue }] = await Promise.all([
    loadHarness(),
    loadInterviews(),
  ]);
  const maxJobs = once ? 1 : 5;
  const [studies, interviews] = await Promise.all([
    processStudyJobQueue({ workerId: `${workerId}:study`, maxJobs }),
    processInterviewJobQueue({ workerId: `${workerId}:interview`, maxJobs }),
  ]);
  return studies + interviews;
}

do {
  const processed = await poll();
  if (once) break;
  if (processed === 0) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
} while (true);

if (once) {
  const { closeDatabase } = await import("../src/lib/db.ts");
  await closeDatabase();
}
