import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  getReportEvidenceGraph,
  materializeReportEvidenceGraph,
  sanitizeReportEvidenceGraphForPublic,
} from "../src/lib/evidence-graph";
import type { ResearchReport } from "../src/lib/openai-provider";
import type { ReportEvidenceCatalogItem } from "../src/lib/report-evidence";

if (process.env.EVIDENCE_GRAPH_SMOKE_CONFIRM !== "1") {
  throw new Error("Set EVIDENCE_GRAPH_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Evidence graph smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

const report: ResearchReport = {
  title: "可审计研究报告烟测",
  executiveSummary: "本报告用于验证公开事实、AI 合成模拟和模型推断能够被明确区分，并且每条结论均可回到其直接证据或清晰显示证据不足。",
  findings: [
    {
      title: "公开资料显示明确约束",
      insight: "两个独立公开来源共同表明，决策者会优先检查成本边界和数据处理要求，再评估体验层面的差异。",
      evidence: "两个公开网页来源分别提供成本与合规约束的直接描述。",
      implication: "产品说明应优先提供可核查的成本计算方式和数据处理边界。",
      claimType: "fact",
      confidence: "high",
      evidenceRefs: ["web-01", "web-02"],
    },
    {
      title: "合成访谈产生待验证方向",
      insight: "AI 合成 Persona 模拟提示，决策者可能需要在团队内部解释方案价值，但这不是现实受访者观察。",
      evidence: "一场 AI 合成访谈模拟给出了内部沟通阻力的情境线索。",
      implication: "后续真人访谈应验证内部说服成本是否真实存在以及出现在哪些角色中。",
      claimType: "synthetic_simulation",
      confidence: "medium",
      evidenceRefs: ["synthetic-01"],
    },
    {
      title: "尚无证据的分析推断",
      insight: "现有材料可能暗示实施周期影响采用意愿，但当前输入没有可作为直接支持的具体来源。",
      evidence: "当前没有绑定直接证据，因此该结论只能作为低置信分析推断。",
      implication: "在新增实施周期证据前，不应将此判断用于外部发布或资源优先级决策。",
      claimType: "model_inference",
      confidence: "low",
      evidenceRefs: [],
    },
  ],
  recommendations: [
    { title: "补充成本证据", action: "建立不同规模下的成本计算表，并允许决策者核对输入条件。", rationale: "公开来源显示成本边界是采用前置条件。", priority: "high" },
    { title: "验证内部说服", action: "用真人访谈验证发起者向采购和安全团队解释价值的具体障碍。", rationale: "当前线索只来自 AI 合成模拟。", priority: "medium" },
    { title: "暂缓实施周期结论", action: "在收集直接证据前，不对实施周期的重要性做排序判断。", rationale: "当前没有直接证据支持。", priority: "low" },
  ],
  limitations: ["AI 合成访谈只用于产生假设，不代表真人样本或统计结论。"],
  nextQuestions: ["不同角色如何评估总成本？", "实施周期在哪些环节产生实际阻力？"],
};

const catalog: ReportEvidenceCatalogItem[] = [
  {
    ref: "web-01", title: "成本边界说明", sourceType: "public_web", evidenceType: "fact",
    content: "公开资料说明总成本需要覆盖采购、部署和持续维护。", sourceUri: "https://example.com/cost",
    locator: { url: "https://example.com/cost" }, metadata: {},
  },
  {
    ref: "web-02", title: "数据处理规范", sourceType: "public_web", evidenceType: "fact",
    content: "公开规范要求在采用前说明数据存储、访问和删除边界。", sourceUri: "https://example.com/privacy",
    locator: { url: "https://example.com/privacy" }, metadata: {},
  },
  {
    ref: "synthetic-01", title: "AI 合成访谈 · 决策发起者", sourceType: "synthetic_interview", evidenceType: "synthetic_simulation",
    content: "我需要向采购和安全团队解释为什么这个方案值得投入。", sourceUri: null,
    locator: { personaName: "决策发起者", batch: 1 }, metadata: { disclaimer: "AI 合成模拟" },
  },
  {
    ref: "human-01", title: "真人访谈 · 已同意参与者", sourceType: "interview_session", evidenceType: "human_observation",
    content: "内部审批通常需要两周，我最担心的是安全团队缺少明确材料。", sourceUri: null,
    locator: { sessionPublicId: `ins_${suffix}`, turnIndex: 3 }, metadata: { consent: true },
  },
];

async function main() {
  const database = await getDatabase();
  try {
    const seeded = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Evidence Smoke"}'::jsonb)`,
        [authUserId, `evidence-${suffix}@example.com`],
      );
      const actor = await transaction.query<{ user_id: string; workspace_id: string }>(
        `select app_user.id::text as user_id, workspace.id::text as workspace_id
         from users app_user join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceId = actor.rows[0].workspace_id;
      const study = await transaction.query<{ id: string }>(
        `insert into studies (public_id, workspace_id, created_by, title, brief, status, current_stage)
         values ($1, $2, $3, 'Evidence smoke', '验证证据图', 'completed', 'report') returning id::text as id`,
        [`std_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const run = await transaction.query<{ id: string }>(
        `insert into study_runs (study_id, status, provider, provider_model, prompt_version, finished_at)
         values ($1, 'completed', 'smoke', 'smoke-model', 'evidence-v1', now()) returning id::text as id`,
        [study.rows[0].id],
      );
      const storedReport = await transaction.query<{ id: string }>(
        `insert into reports (public_id, study_id, title, content_html, content_json)
         values ($1, $2, $3, '<article>smoke</article>', $4::jsonb) returning id::text as id`,
        [`rpt_${suffix}`, study.rows[0].id, report.title, JSON.stringify(report)],
      );
      const historicalStudy = await transaction.query<{ id: string }>(
        `insert into studies (public_id, workspace_id, created_by, title, brief, status, current_stage)
         values ($1, $2, $3, 'Historical report', '无证据图的历史报告', 'completed', 'report') returning id::text as id`,
        [`std_history_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const historicalReport = await transaction.query<{ id: string }>(
        `insert into reports (public_id, study_id, title, content_html, content_json)
         values ($1, $2, '历史报告', '<article>legacy</article>', '{}'::jsonb) returning id::text as id`,
        [`rpt_history_${suffix}`, historicalStudy.rows[0].id],
      );
      return {
        studyId: study.rows[0].id,
        runId: run.rows[0].id,
        reportId: storedReport.rows[0].id,
        historicalReportId: historicalReport.rows[0].id,
      };
    });

    const first = await database.transaction((transaction) => materializeReportEvidenceGraph(transaction, {
      workspaceId: workspaceId!, studyId: seeded.studyId, runId: seeded.runId, reportId: seeded.reportId,
      report, citations: catalog.filter((item) => item.sourceUri).map((item) => ({ title: item.title, url: item.sourceUri! })),
      catalog, provider: "smoke", providerModel: "smoke-model", providerResponseId: `resp_${suffix}`, promptVersion: "evidence-v1",
    }));
    const second = await database.transaction((transaction) => materializeReportEvidenceGraph(transaction, {
      workspaceId: workspaceId!, studyId: seeded.studyId, runId: seeded.runId, reportId: seeded.reportId,
      report, citations: [], catalog, provider: "smoke", providerModel: "smoke-model", providerResponseId: `resp_${suffix}`, promptVersion: "evidence-v1",
    }));
    assert.equal(first.id, second.id, "same run must not create another report version");

    const graph = await getReportEvidenceGraph(database, seeded.reportId);
    assert(graph);
    assert.equal(graph.version, 1);
    assert.equal(graph.nodes.length, 10);
    const findings = graph.nodes.filter((node) => node.nodeType === "finding");
    assert.equal(findings.length, 3);
    assert.equal(findings[0].claim?.claimType, "fact");
    assert.equal(findings[0].claim?.evidence.length, 2);
    assert.equal(findings[1].claim?.claimType, "synthetic_simulation");
    assert.equal(findings[1].claim?.evidence[0].ref, "synthetic-01");
    assert.equal(findings[2].claim?.supportStatus, "unsupported");
    assert.equal(findings[2].claim?.evidence.length, 0);

    const humanCatalogItem = catalog.find((item) => item.ref === "human-01");
    assert(humanCatalogItem);
    const publicGraph = sanitizeReportEvidenceGraphForPublic({
      ...graph,
      nodes: graph.nodes.map((node) => node.publicId === findings[0].publicId && node.claim ? {
        ...node,
        claim: {
          ...node.claim,
          evidence: [...node.claim.evidence, {
            publicId: `evi_human_${suffix}`,
            ref: humanCatalogItem.ref,
            title: humanCatalogItem.title,
            sourceType: humanCatalogItem.sourceType,
            evidenceType: humanCatalogItem.evidenceType,
            content: humanCatalogItem.content,
            sourceUri: humanCatalogItem.sourceUri,
            locator: humanCatalogItem.locator,
            stance: "supports",
            strength: "medium",
          }],
        },
      } : node),
    });
    const humanItem = publicGraph?.nodes.flatMap((node) => node.claim?.evidence ?? []).find((item) => item.ref === "human-01");
    assert(humanItem);
    assert.equal(humanItem.locator && Object.keys(humanItem.locator).length, 0);
    assert.match(humanItem.content, /公开分享不展示/);
    assert.equal(await getReportEvidenceGraph(database, seeded.historicalReportId), null);

    const counts = await database.query<{ versions: number; nodes: number; claims: number; sources: number; items: number; links: number }>(
      `select
         (select count(*)::int from report_versions where report_id = $1) as versions,
         (select count(*)::int from report_nodes where report_version_id = $2) as nodes,
         (select count(*)::int from claims where study_id = $3) as claims,
         (select count(*)::int from evidence_sources where study_id = $3) as sources,
         (select count(*)::int from evidence_items item join evidence_sources source on source.id = item.source_id where source.study_id = $3) as items,
         (select count(*)::int from claim_evidence link join claims claim on claim.id = link.claim_id where claim.study_id = $3) as links`,
      [seeded.reportId, first.id, seeded.studyId],
    );
    assert.deepEqual(counts.rows[0], { versions: 1, nodes: 10, claims: 3, sources: 4, items: 4, links: 3 });
    console.log(JSON.stringify({ ...counts.rows[0], versionPublicId: graph.versionPublicId, legacyGraph: null, publicHumanEvidenceRedacted: true }, null, 2));
  } finally {
    if (workspaceId) await database.query("delete from workspaces where id = $1", [workspaceId]);
    await database.query("delete from auth.users where id = $1", [authUserId]);
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
