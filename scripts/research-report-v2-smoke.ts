import assert from "node:assert/strict";
import {
  assessPublicWebSourceQuality,
  assessResearchAnswerability,
  classifyResearchQuestionTypes,
  curatePublicWebSources,
} from "../src/lib/research-report-design";
import {
  buildReportEvidenceCatalog,
  getClaimSupportStatus,
  hasInferentialLanguage,
  toReaderFacingEvidenceText,
} from "../src/lib/report-evidence";

const source = (title: string, excerpt: string, url = "https://example.com/source") => ({ title, excerpt, url });

const behaviorBrief = "九号与雅迪内容策略：用户为什么分享、收藏并信任哪类内容，给出内容方案";
assert.deepEqual(classifyResearchQuestionTypes(behaviorBrief), ["behavioral", "attitudinal", "comparative", "strategic"]);

const weakSources = [
  source("九号产品页", "九号两轮电动车提供续航、安全、智能功能和售后服务说明。".repeat(12)),
  source("雅迪产品页", "雅迪两轮电动车提供续航、安全、智能功能和售后服务说明。".repeat(12)),
  source("行业概览", "两轮电动车市场持续变化，品牌需要围绕通勤和安全场景提供清晰内容。".repeat(12)),
];
const directional = assessResearchAnswerability({ brief: behaviorBrief, sources: weakSources });
assert.equal(directional.level, "directional", "没有平台行为或真人态度证据时必须降级为方向性分析");
assert.equal(directional.platformSourceCount, 0);
assert.ok(directional.gaps.length >= 2);

assert.equal(assessResearchAnswerability({ brief: behaviorBrief, sources: [] }).level, "insufficient");

const platformSources = [1, 2, 3].map((index) => source(
  `小红书内容 ${index}`,
  `用户评论区分享收藏和点赞数据反映真实体验，用户表示会比较续航、安全和售后。${"公开讨论内容。".repeat(20)}`,
  `https://www.xiaohongshu.com/explore/${index}`,
));
const decisionReady = assessResearchAnswerability({ brief: behaviorBrief, sources: [...weakSources, ...platformSources], hasHumanObservations: true });
assert.equal(decisionReady.level, "decision_ready", "平台互动指标和真人态度材料足够时可进入决策研究层");
assert.ok(decisionReady.platformSourceCount >= 3);

const interviewsWithoutBehavior = assessResearchAnswerability({
  brief: behaviorBrief,
  sources: weakSources,
  hasHumanObservations: true,
});
assert.equal(interviewsWithoutBehavior.level, "directional", "真人访谈不能替代分享、收藏或点击等行为证据");
assert.ok(interviewsWithoutBehavior.gaps.some((gap) => gap.includes("行为")));

const curated = curatePublicWebSources(behaviorBrief, [
  source("维护页面", `System maintenance temporarily unavailable ${"placeholder ".repeat(50)}`),
  source("海外电动滑板车", `Electric scooter product comparison ${"scooter details ".repeat(40)}`),
  source("相关评测", `九号 雅迪 两轮电动车 续航 安全 收藏 评论区 用户表示 ${"公开评测内容。".repeat(20)}`),
]);
assert.equal(assessPublicWebSourceQuality(curated.sources[0], behaviorBrief).accepted, true);
assert.equal(curated.sources.length, 1);
assert.ok(curated.rejected.some((item) => item.assessment.reasons.includes("unavailable_page")));
assert.ok(curated.rejected.some((item) => item.assessment.reasons.includes("low_relevance")));

const catalog = buildReportEvidenceCatalog({
  sources: [source("公开来源", "公开资料提供品类事实和产品参数。")],
  panelResearch: {
    panel: { title: "合成 Panel", description: "用于生成待验证假设。" },
    personas: [],
    interviews: [],
    validation: { directions: [], summary: "仅用于烟测。" },
  },
});
assert.equal(catalog[0].evidenceType, "fact");
assert.equal(catalog[0].sourceType, "public_web");
assert.equal(getClaimSupportStatus("fact", [catalog[0]]), "supported");
assert.equal(getClaimSupportStatus("model_inference", [catalog[0]]), "mixed");
assert.equal(getClaimSupportStatus("fact", [{
  ...catalog[0],
  sourceType: "synthetic_interview",
  evidenceType: "synthetic_simulation",
}]), "mixed", "类型不匹配的引用不能显示为直接支持");
assert.equal(getClaimSupportStatus("human_observation", [catalog[0]]), "mixed");
assert.equal(getClaimSupportStatus("fact", []), "unsupported");
assert.equal(hasInferentialLanguage("该结构可作为内容实验框架"), true);
assert.equal(hasInferentialLanguage("公开资料包含续航和安全信息"), false);
assert.equal(
  toReaderFacingEvidenceText("behavioralEvidenceCount 为 0，参考 web-01。", catalog),
  "行为证据数量 为 0，参考 《公开来源》。",
);

console.log(JSON.stringify({
  questionTypes: directional.questionTypes,
  directional: directional.level,
  decisionReady: decisionReady.level,
  curatedSources: curated.sources.length,
  rejectedReasons: curated.rejected.flatMap((item) => item.assessment.reasons),
  inferenceEvidencePolicy: "model_inference references are contextual/mixed, never direct",
}, null, 2));
