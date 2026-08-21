import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { confirmStudyPlan } from "../src/lib/studies";
import { executeUniversalAgentProductTool } from "../src/lib/universal-agent-product-tools";

if (process.env.UNIVERSAL_AGENT_PRODUCT_TOOLS_DB_SMOKE_CONFIRM !== "1") {
  throw new Error("Set UNIVERSAL_AGENT_PRODUCT_TOOLS_DB_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Universal Agent product tool DB smoke only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID()];
const workspaceIds: string[] = [];

const personaInput = {
  name: "稳定通勤者",
  archetype: "直达优先",
  age: 34,
  city: "台北",
  occupation: "产品经理",
  commute: "工作日搭乘公共交通通勤",
  budget: "每月中等交通预算",
  currentSituation: "雨天会重新评估路线，并优先减少换乘与延误风险。",
  goals: ["稳定到达", "减少换乘"],
  painPoints: ["换乘不确定", "雨天拥堵"],
  decisionStyle: "先比较直达性和延误风险，再比较价格与理论最短时间。",
  tags: ["通勤", "公交"],
  visibility: "workspace" as const,
  addToPanelPublicIds: [],
};

function requireResult<T extends { status: string }>(value: T, status: T["status"]) {
  assert.equal(value.status, status);
  for (const key of ["resourceType", "resourcePublicId", "href", "summary", "nextAction"] as const) {
    assert.ok(key in value, `missing normalized product tool field: ${key}`);
  }
  return value;
}

async function main() {
  const oldEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    PLAN_PROVIDER: process.env.PLAN_PROVIDER,
    RESEARCH_PROVIDER: process.env.RESEARCH_PROVIDER,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.PLAN_PROVIDER = "deepseek";
  process.env.RESEARCH_PROVIDER = "openai";

  const database = await getDatabase();
  try {
    const viewers = [];
    for (const [index, authUserId] of authUserIds.entries()) {
      await database.query(
        "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)",
        [authUserId, `agent-product-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `Agent product ${index}` })],
      );
      const actor = await database.query<{
        user_id: string; user_public_id: string; workspace_id: string;
        workspace_public_id: string; workspace_name: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id,
                workspace.name as workspace_name
         from users app_user join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceIds.push(actor.rows[0].workspace_id);
      viewers.push({
        userId: actor.rows[0].user_id, userPublicId: actor.rows[0].user_public_id,
        displayName: `Agent product ${index}`, email: `agent-product-${index}-${suffix}@example.com`,
        workspaceId: actor.rows[0].workspace_id, workspacePublicId: actor.rows[0].workspace_public_id,
        workspaceName: actor.rows[0].workspace_name, role: "owner" as const, tokenBalance: 0,
      });
    }
    const [viewer, outsider] = viewers;

    const persona = requireResult(await executeUniversalAgentProductTool({
      viewer, toolName: "persona.create", arguments: personaInput, executionAllowed: true,
    }), "created");
    assert.equal(persona.resourceType, "persona");
    assert.match(persona.resourcePublicId ?? "", /^per_/);

    const personaList = requireResult(await executeUniversalAgentProductTool({
      viewer, toolName: "persona.list", arguments: { limit: 10 }, executionAllowed: false,
    }), "ok");
    assert.equal(personaList.resourceType, "persona_collection");
    const listedPersonas = personaList.data?.personas as Array<{ publicId: string }>;
    assert(listedPersonas.some((item) => item.publicId === persona.resourcePublicId));
    const outsiderList = requireResult(await executeUniversalAgentProductTool({
      viewer: outsider, toolName: "persona.list", arguments: { limit: 10 }, executionAllowed: false,
    }), "ok");
    assert.equal((outsiderList.data?.personas as unknown[]).length, 0);

    process.env.OPENAI_API_KEY = "isolated-product-tool-smoke-key";
    const interview = requireResult(await executeUniversalAgentProductTool({
      viewer,
      toolName: "interview.create",
      arguments: {
        title: "通勤决策 AI 访谈",
        objective: "理解雨天通勤时对直达性、延误风险和价格的取舍。",
        personaPublicIds: [persona.resourcePublicId],
      },
      executionAllowed: true,
    }), "queued");
    assert.equal(interview.resourceType, "interview");
    const interviewQueue = await database.query<{
      run_status: string; job_status: string; persona_count: number;
    }>(
      `select run.status as run_status, job.status as job_status,
              (select count(*)::int from interview_project_personas member where member.project_id = project.id) as persona_count
       from interview_projects project join interview_runs run on run.project_id = project.id
       join interview_job_queue job on job.run_id = run.id
       where project.public_id = $1 and project.workspace_id = $2`,
      [interview.resourcePublicId, viewer.workspaceId],
    );
    assert.deepEqual(interviewQueue.rows[0], { run_status: "queued", job_status: "queued", persona_count: 1 });

    delete process.env.OPENAI_API_KEY;
    const research = requireResult(await executeUniversalAgentProductTool({
      viewer,
      toolName: "research.create",
      arguments: {
        brief: "研究城市上班族在雨天通勤时如何在直达性、时间和价格之间取舍。",
        productLine: "research",
      },
      executionAllowed: true,
    }), "clarification_required");
    assert.equal(research.resourceType, "study");
    assert.match(research.resourcePublicId ?? "", /^std_/);

    process.env.OPENAI_API_KEY = "isolated-product-tool-smoke-key";
    const unconfirmed = requireResult(await executeUniversalAgentProductTool({
      viewer, toolName: "research.run_confirmed",
      arguments: { studyPublicId: research.resourcePublicId }, executionAllowed: true,
    }), "blocked");
    assert.equal(unconfirmed.data?.queueStatus, "plan_not_confirmed");
    const beforeConfirmation = await database.query<{ run_count: number; job_count: number }>(
      `select
         (select count(*)::int from study_runs run join studies study on study.id = run.study_id where study.public_id = $1) as run_count,
         (select count(*)::int from study_job_queue job join study_runs run on run.id = job.run_id
           join studies study on study.id = run.study_id where study.public_id = $1) as job_count`,
      [research.resourcePublicId],
    );
    assert.deepEqual(beforeConfirmation.rows[0], { run_count: 0, job_count: 0 });

    assert.equal(await confirmStudyPlan(viewer, research.resourcePublicId!), "confirmed");
    const queuedResearch = requireResult(await executeUniversalAgentProductTool({
      viewer, toolName: "research.run_confirmed",
      arguments: { studyPublicId: research.resourcePublicId }, executionAllowed: true,
    }), "queued");
    assert.equal(queuedResearch.resourcePublicId, research.resourcePublicId);
    const researchQueue = await database.query<{ run_status: string; job_status: string }>(
      `select run.status as run_status, job.status as job_status
       from studies study join lateral (
         select id, status from study_runs where study_id = study.id order by created_at desc, id desc limit 1
       ) run on true join study_job_queue job on job.run_id = run.id
       where study.public_id = $1 and study.workspace_id = $2`,
      [research.resourcePublicId, viewer.workspaceId],
    );
    assert.deepEqual(researchQueue.rows[0], { run_status: "queued", job_status: "queued" });
    const alreadyRunning = requireResult(await executeUniversalAgentProductTool({
      viewer, toolName: "research.run_confirmed",
      arguments: { studyPublicId: research.resourcePublicId }, executionAllowed: true,
    }), "ok");
    assert.equal(alreadyRunning.data?.queueStatus, "already_running");
    const queueCount = await database.query<{ run_count: number; job_count: number }>(
      `select
         (select count(*)::int from study_runs run join studies study on study.id = run.study_id where study.public_id = $1) as run_count,
         (select count(*)::int from study_job_queue job join study_runs run on run.id = job.run_id
           join studies study on study.id = run.study_id where study.public_id = $1) as job_count`,
      [research.resourcePublicId],
    );
    assert.deepEqual(queueCount.rows[0], { run_count: 1, job_count: 1 });

    const reportPublicId = `rpt_${suffix}`;
    const reportContent = {
      title: "雨天通勤决策研究报告",
      executiveSummary: "隔离验收报告用于验证 Universal Agent 能在工作区权限边界内读取已生成报告，且不会向其他工作区暴露报告内容。",
      findings: [], recommendations: [], limitations: ["仅用于隔离验收。"], nextQuestions: ["下一步如何验证？", "如何扩大样本？"],
    };
    await database.query(
      `insert into reports (public_id, study_id, title, description, content_html, content_json)
       select $1, id, $2, $3, '<article>isolated smoke report</article>', $4::jsonb
       from studies where public_id = $5 and workspace_id = $6`,
      [reportPublicId, reportContent.title, reportContent.executiveSummary, JSON.stringify(reportContent), research.resourcePublicId, viewer.workspaceId],
    );
    await database.query(
      "update studies set status = 'completed', current_stage = 'report', updated_at = now() where public_id = $1 and workspace_id = $2",
      [research.resourcePublicId, viewer.workspaceId],
    );
    const report = requireResult(await executeUniversalAgentProductTool({
      viewer, toolName: "report.read", arguments: { studyPublicId: research.resourcePublicId }, executionAllowed: false,
    }), "ok");
    assert.equal(report.resourceType, "report");
    assert.equal(report.resourcePublicId, reportPublicId);
    assert.equal((report.data?.report as { title: string }).title, reportContent.title);

    const hiddenReport = requireResult(await executeUniversalAgentProductTool({
      viewer: outsider, toolName: "report.read", arguments: { studyPublicId: research.resourcePublicId }, executionAllowed: false,
    }), "not_found");
    assert.equal(hiddenReport.error, "study_not_found");
    assert.equal(hiddenReport.href, null);

    console.log(JSON.stringify({
      personaCreatedAndListed: true,
      personaWorkspaceIsolation: true,
      interviewCreatedAndQueued: true,
      unconfirmedResearchBlockedWithoutRun: true,
      confirmedResearchQueued: true,
      duplicateResearchQueuePrevented: true,
      reportRead: true,
      reportWorkspaceIsolation: true,
      normalizedProductToolContract: true,
    }, null, 2));
  } finally {
    if (workspaceIds.length) {
      await database.query("delete from interview_projects where workspace_id = any($1::bigint[])", [workspaceIds]);
    }
    for (const workspaceId of workspaceIds) await database.query("delete from workspaces where id = $1", [workspaceId]);
    for (const authUserId of authUserIds) await database.query("delete from auth.users where id = $1", [authUserId]);
    for (const [key, value] of Object.entries(oldEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await closeDatabase();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
