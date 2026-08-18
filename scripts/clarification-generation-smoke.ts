import assert from "node:assert/strict";
import { createFallbackClarificationQuestions } from "../src/lib/studies";

const sharedBike = createFallbackClarificationQuestions(
  "分析中国城市通勤用户选择共享单车时最关注的三个因素。",
  "research",
);
const sharedBikeText = JSON.stringify(sharedBike);
for (const unrelatedTerm of ["续航", "充电", "换电", "换购"]) {
  assert.equal(sharedBikeText.includes(unrelatedTerm), false, `shared-bike clarification leaked term: ${unrelatedTerm}`);
}

const electricBike = createFallbackClarificationQuestions(
  "研究城市用户换购电动自行车时对续航与充电体验的权衡。",
  "research",
);
assert(JSON.stringify(electricBike).includes("续航"));

const marketInsight = createFallbackClarificationQuestions(
  "分析东南亚共享出行市场格局与进入机会。",
  "market_insight",
);
assert.equal(marketInsight[2]?.label, "市场范围");
assert(marketInsight.every((question) => question.options.length === 4));

console.log(JSON.stringify({
  sharedBikeUsesNeutralFallback: true,
  electricBikeUsesMobilityFallback: true,
  marketInsightScopePreserved: true,
}));
