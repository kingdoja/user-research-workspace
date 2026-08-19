import assert from "node:assert/strict";

process.env.PLAN_PROVIDER = "deepseek";
process.env.RESEARCH_PROVIDER = "deepseek";
process.env.REASONING_PROVIDER = "deepseek";
process.env.REPORT_PROVIDER = "yundu";
process.env.REPORT_JUDGE_PROVIDER = "deepseek";
process.env.DEEPSEEK_FAST_MODEL = "deepseek-v4-flash";
process.env.DEEPSEEK_REASONING_MODEL = "deepseek-v4-pro";
process.env.REPORT_MODEL = "gpt-5.6-terra";
process.env.REPORT_JUDGE_MODEL = "deepseek-v4-pro";

async function main() {
  const { getProviderStageStatus } = await import("../src/lib/openai-provider");
  const {
    createMarketInsightTaskPlan,
    createResearchTaskPlan,
    finalizeApprovedReportPacket,
    finalizeRevisedReportPacket,
  } = await import("../src/lib/research-harness");

  assert.deepEqual(
    ["research", "reasoning", "report", "judge"].map((stage) => {
      const status = getProviderStageStatus(stage as "research" | "reasoning" | "report" | "judge");
      return [status.providerName, status.model];
    }),
    [
      ["deepseek", "deepseek-v4-flash"],
      ["deepseek", "deepseek-v4-pro"],
      ["yundu", "gpt-5.6-terra"],
      ["deepseek", "deepseek-v4-pro"],
    ],
  );

  for (const tasks of [
    createResearchTaskPlan({ studyType: "user_research", methods: ["Interview Chat"] }),
    createMarketInsightTaskPlan({ methods: ["Fast Insight"] }),
  ]) {
    const draft = tasks.find((task) => task.key === "report");
    const review = tasks.find((task) => task.key === "report_review");
    const final = tasks.find((task) => task.key === "final_report");
    assert.equal(draft?.toolName, "generateReport");
    assert.equal(review?.toolName, "judgeReport");
    assert.deepEqual(review?.dependsOn, ["report"]);
    assert.equal(final?.toolName, "finalizeReport");
    assert.deepEqual(final?.dependsOn, ["report_review"]);
  }

  const draft = {
    report: {
      title: "测试研究报告",
      executiveSummary: "用于验证已通过评审的报告不会触发额外模型调用，并完整保留初稿模型溯源信息。".repeat(2),
      findings: [],
      recommendations: [],
      limitations: ["仅用于契约测试。"],
      nextQuestions: ["后续应如何验证？", "还需要哪些证据？"],
    },
    citations: [{ title: "测试来源", url: "https://example.com/evidence" }],
    responseId: "terra-draft-response",
    model: "gpt-5.6-terra",
    provider: "yundu",
    promptVersion: "report-v1",
    usage: { total_tokens: 1234 },
  };
  const review = {
    verdict: "approved" as const,
    score: 92,
    summary: "证据引用、结论边界和建议均满足发布标准。",
    issues: [],
    responseId: "deepseek-judge-response",
    model: "deepseek-v4-pro",
    provider: "deepseek",
    promptVersion: "judge-v1",
    usage: { total_tokens: 321 },
  };
  const finalized = finalizeApprovedReportPacket(draft, review);
  assert.equal(finalized.revisionApplied, false);
  assert.equal(finalized.responseId, draft.responseId);
  assert.equal(finalized.provider, "yundu");
  assert.equal(finalized.model, "gpt-5.6-terra");
  assert.equal(finalized.usage, null);
  assert.equal(finalized.qualityReview.responseId, review.responseId);

  const reviseReview = { ...review, verdict: "revise" as const, issues: [{
      severity: "high" as const,
      category: "unsupported_claim" as const,
      description: "存在没有证据引用支持的关键事实断言。",
      recommendation: "删除该断言或将其降级为低置信度分析推断。",
    }] };
  assert.throws(
    () => finalizeApprovedReportPacket(draft, reviseReview),
    /REPORT_REQUIRES_REVISION/,
  );
  const revised = finalizeRevisedReportPacket(draft, reviseReview, {
    report: { ...draft.report, title: "定向修订后的测试研究报告" },
    responseId: "terra-revision-response",
    model: "gpt-5.6-terra",
    provider: "yundu",
    promptVersion: "revision-v1",
    usage: { total_tokens: 456 },
  });
  assert.equal(revised.revisionApplied, true);
  assert.equal(revised.responseId, "terra-revision-response");
  assert.deepEqual(revised.citations, draft.citations);
  assert.equal(revised.qualityReview.verdict, "revise");

  console.log(JSON.stringify({
    routing: "flash-pro-terra-pro",
    reportDag: ["generateReport", "judgeReport", "finalizeReport"],
    approvedPassThrough: true,
    revisionGate: true,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
