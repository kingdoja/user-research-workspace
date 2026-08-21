import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { buildReportEvidenceCatalog } from "../src/lib/report-evidence";

loadEnvConfig(process.cwd());

async function main() {
  if (process.env.REPORT_PROVIDER_SMOKE_CONFIRM !== "1") {
    throw new Error("Set REPORT_PROVIDER_SMOKE_CONFIRM=1 to call the configured report and judge providers.");
  }
  const {
    getProviderStageStatus,
    judgeProviderResearchReport,
    synthesizeProviderResearchReport,
  } = await import("../src/lib/openai-provider");
  const reportStatus = getProviderStageStatus("report");
  const judgeStatus = getProviderStageStatus("judge");
  const expectedReportProvider = process.env.EXPECTED_REPORT_PROVIDER?.trim().toLowerCase() || "deepseek";
  const expectedReportModel = process.env.EXPECTED_REPORT_MODEL?.trim() || "deepseek-v4-pro";
  assert.equal(reportStatus.providerName, expectedReportProvider);
  assert.equal(reportStatus.model, expectedReportModel);
  assert.equal(reportStatus.configured, true);
  assert.equal(judgeStatus.providerName, "deepseek");
  assert.equal(judgeStatus.model, "deepseek-v4-pro");
  assert.equal(judgeStatus.configured, true);

  const sources = [
    {
      title: "合成测试来源：采购验证",
      url: "https://example.com/research-governance",
      excerpt: "本条为供应商联调专用的合成证据：团队在采购 AI 研究工具前，应验证证据引用、权限边界与输出复核流程。",
    },
    {
      title: "合成测试来源：试点指标",
      url: "https://example.com/pilot-metrics",
      excerpt: "本条为供应商联调专用的合成证据：小规模试点可以同时记录交付时长、人工复核时间和关键结论错误率。",
    },
    {
      title: "合成测试来源：采用风险",
      url: "https://example.com/adoption-risks",
      excerpt: "本条为供应商联调专用的合成证据：如果报告无法区分公开事实、合成模拟与模型推断，决策者可能高估结论可靠性。",
    },
    {
      title: "合成测试来源：成本边界",
      url: "https://example.com/cost-controls",
      excerpt: "本条为供应商联调专用的合成证据：采用评估应同时考虑模型费用、检索费用、人工审核成本和失败重试成本。",
    },
  ];
  const reportResult = await synthesizeProviderResearchReport({
    brief: "使用合成证据验证高质量 AI 研究报告流水线，不得将测试内容表述为真实市场调查。",
    framework: "证据治理、试点指标、风险边界与成本控制",
    methods: ["Fast Insight"],
    audience: "需要评估 AI 研究工具的产品与研究负责人",
    userPublicId: "report-provider-smoke",
    studyPublicId: "report-provider-smoke",
    queries: ["AI 研究工具证据治理", "AI 研究工具试点评估"],
    sources,
  });
  assert.equal(reportResult.provider, reportStatus.providerName);
  assert.equal(reportResult.model, reportStatus.model);
  assert.ok(reportResult.responseId);
  assert.ok(reportResult.report.findings.length >= 3);

  const review = await judgeProviderResearchReport({
    report: reportResult.report,
    evidenceCatalog: buildReportEvidenceCatalog({ sources }),
    userPublicId: "report-provider-smoke",
    studyPublicId: "report-provider-smoke",
  });
  assert.equal(review.provider, "deepseek");
  assert.equal(review.model, judgeStatus.model);
  assert.ok(review.responseId);
  assert.ok(review.score >= 0 && review.score <= 100);
  if (review.verdict === "revise") assert.ok(review.issues.length > 0);

  console.log(JSON.stringify({
    report: {
      provider: reportResult.provider,
      model: reportResult.model,
      responseId: reportResult.responseId,
      findingCount: reportResult.report.findings.length,
    },
    judge: {
      provider: review.provider,
      model: review.model,
      responseId: review.responseId,
      verdict: review.verdict,
      score: review.score,
      issueCount: review.issues.length,
    },
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
