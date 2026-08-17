import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  if (process.env.DEEPSEEK_PROVIDER_SMOKE_CONFIRM !== "1") {
    throw new Error("Set DEEPSEEK_PROVIDER_SMOKE_CONFIRM=1 to call the configured DeepSeek API.");
  }

  const {
    generateProviderResearchInterviews,
    generateProviderStudyPlan,
    getOpenAIProviderStatus,
  } = await import("../src/lib/openai-provider");
  const status = getOpenAIProviderStatus();
  assert.equal(status.planProviderName, "deepseek");
  assert.equal(status.planConfigured, true);

  const plan = await generateProviderStudyPlan(
    "仅使用公开网页资料研究台湾中小型团队采用 AI 研究工具时的主要决策约束。",
    "deepseek-provider-smoke",
  );

  assert.ok(plan.responseId);
  assert.equal(plan.model, status.planModel);
  assert.ok(plan.framework.length >= 2);
  assert.ok(plan.rationale.length >= 20);

  const interviews = await generateProviderResearchInterviews({
    brief: "研究台湾中小型团队采用 AI 研究工具时的决策约束。",
    audience: "负责研究与产品决策的中小型团队负责人",
    userPublicId: "deepseek-provider-smoke",
    studyPublicId: "deepseek-provider-smoke",
    batch: 1,
    personas: [
      {
        name: "林怡君",
        archetype: "谨慎的研究负责人",
        age: 36,
        city: "台北",
        occupation: "用户研究负责人",
        commute: "每周三天搭乘捷运通勤",
        budget: "每月新台币三万元以内",
        currentSituation: "团队需要提升研究速度，但必须保留证据链与审核流程。",
        goals: ["缩短研究交付周期", "确保研究结论可以审计"],
        painPoints: ["工具输出缺乏来源", "模型结果难以稳定复现"],
        decisionStyle: "先用小规模试点验证准确性，再根据证据与成本决定是否扩展。",
        tags: ["研究治理", "证据导向", "谨慎采购"],
      },
      {
        name: "陈志明",
        archetype: "效率导向的产品经理",
        age: 32,
        city: "新竹",
        occupation: "资深产品经理",
        commute: "主要骑车往返公司与住处",
        budget: "每月新台币两万元以内",
        currentSituation: "产品迭代快速，希望减少等待传统访谈排期的时间。",
        goals: ["快速验证产品假设", "减少跨团队沟通成本"],
        painPoints: ["研究排期经常延误", "洞察难以转成产品动作"],
        decisionStyle: "优先评估能否直接支持当前路线图，再比较导入成本与团队学习负担。",
        tags: ["产品迭代", "效率优先", "快速验证"],
      },
    ],
  });

  assert.equal(status.researchProviderName, "deepseek");
  assert.equal(status.researchConfigured, true);
  assert.equal(interviews.length, 1);
  assert.equal(interviews[0].batch, 1);
  assert.ok(interviews[0].summary.length >= 80);

  console.log(JSON.stringify({
    provider: status.planProviderName,
    protocol: status.planProtocol,
    model: plan.model,
    responseId: plan.responseId,
    studyType: plan.studyType,
    methods: plan.methods,
    planStructuredOutput: true,
    researchInterviewCount: interviews.length,
    researchStructuredOutput: true,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
