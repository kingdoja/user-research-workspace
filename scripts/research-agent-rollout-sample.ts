import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import {
  confirmStudyPlan,
  createStudy,
  submitStudyClarification,
  type ClarificationAnswer,
} from "../src/lib/studies";
import { enqueueLatestStudyRun, processStudyJobQueue } from "../src/lib/research-harness";

loadEnvConfig(process.cwd());

const viewer = {
  userId: "28",
  userPublicId: "usr_c37f9cf7fd474c9295f941c4b28845b2",
  displayName: "kingdo",
  email: "shuneng.lin@ninebot.com",
  workspaceId: "28",
  workspacePublicId: "wsp_4bbb838633a54496bc1ca86862929dfb",
  workspaceName: "kingdo 的研究工作区",
  role: "owner" as const,
  tokenBalance: 1_000_000,
};

function chooseAnswers(questions: Array<{ id: string; question: string; options: string[]; maxSelect: number }>): ClarificationAnswer[] {
  return questions.map((question) => {
    const prompt = `${question.id} ${question.question}`.toLowerCase();
    const preferred = question.options.find((option) => {
      const text = option.toLowerCase();
      if (prompt.includes("goal") || prompt.includes("目标") || prompt.includes("business")) return text.includes("定位") || text.includes("优先") || text.includes("决策");
      if (prompt.includes("focus") || prompt.includes("重点") || prompt.includes("research")) return text.includes("决策") || text.includes("痛点") || text.includes("需求");
      if (prompt.includes("audience") || prompt.includes("人群") || prompt.includes("用户")) return text.includes("现有") || text.includes("目标") || text.includes("用户");
      if (prompt.includes("scope") || prompt.includes("范围") || prompt.includes("资料")) return text.includes("公开") || text.includes("网页") || text.includes("ai") || text.includes("合成");
      return false;
    });
    return { questionId: question.id, selected: [preferred ?? question.options[0]].slice(0, Math.max(1, question.maxSelect)) };
  });
}

async function main() {
  const brief = process.argv.slice(2).join(" ") || "评估九号两轮电动车面向现有用户的产品定位、核心痛点与下一阶段机会，形成可核查证据和行动建议。";
  const studyPublicId = await createStudy(viewer, brief, "research");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const database = new Client({ connectionString: databaseUrl, ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false } });
  await database.connect();
  try {
    const event = await database.query<{ payload: Record<string, unknown> | string }>(
      `select payload from study_events join studies on studies.id = study_events.study_id where studies.public_id = $1 and event_type = 'clarification.requested' order by study_events.created_at desc, study_events.id desc limit 1`,
      [studyPublicId],
    );
    const payload = typeof event.rows[0]?.payload === "string" ? JSON.parse(event.rows[0].payload) : event.rows[0]?.payload;
    const questions = Array.isArray(payload?.questions) ? payload.questions as Array<{ id: string; question: string; options: string[]; maxSelect: number }> : [];
    if (!questions.length) throw new Error("ROLL_OUT_CLARIFICATION_NOT_FOUND");
    const clarificationStatus = await submitStudyClarification(viewer, studyPublicId, chooseAnswers(questions));
    if (clarificationStatus !== "completed" && clarificationStatus !== "already_completed") throw new Error(`ROLL_OUT_CLARIFICATION_${clarificationStatus}`);
    const confirmStatus = await confirmStudyPlan(viewer, studyPublicId);
    if (confirmStatus !== "confirmed" && confirmStatus !== "already_confirmed") throw new Error(`ROLL_OUT_CONFIRM_${confirmStatus}`);
    const runId = await enqueueLatestStudyRun(studyPublicId, viewer.workspaceId);
    if (!runId) throw new Error("ROLL_OUT_RUN_NOT_QUEUED");
    const workerId = `codex-rollout-${Date.now()}`;
    const processed = await processStudyJobQueue({ workerId, maxJobs: 1 });
    const run = await database.query(`select r.id::text as run_id, r.status, r.error_message, q.status as job_status, q.attempt, q.lease_owner from study_runs r left join study_job_queue q on q.run_id = r.id where r.id = $1`, [runId]);
    console.log(JSON.stringify({ studyPublicId, runId, workerId, processed, ...run.rows[0] }, null, 2));
  } finally {
    await database.end();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
