import assert from "node:assert/strict";
import { assessResearchAgentRolloutQuality, validateResearchAgentAction } from "../src/lib/research-agent-controller";
import { parseResearchAgentAction, type AgentAction } from "../src/lib/research-agent-contract";
import { parseProviderSearchSourcePlan } from "../src/lib/openai-provider";
import { parseTaskInputRequest, validateTaskInputResponse } from "../src/lib/task-input-contract";

const tasks = [
  {
    key: "design",
    title: "设计研究框架",
    toolName: "designStudy",
    status: "completed",
    dependsOn: [],
    input: {},
  },
  {
    key: "research",
    title: "检索公开资料",
    toolName: "deepResearch",
    status: "pending",
    dependsOn: ["design"],
    input: { focus: "证据" },
  },
];

const rolloutMetrics = {
  controllerFailureRate: 0,
  policyRejectRate: 0.1,
  callToolMatchRate: 1,
  templateMatchRate: 1,
  reportGatePassed: true,
};
assert.deepEqual(assessResearchAgentRolloutQuality({ metrics: [rolloutMetrics] }), {
  passed: true,
  reason: "shadow_quality_gate_passed",
});
assert.deepEqual(assessResearchAgentRolloutQuality({
  metrics: [{ ...rolloutMetrics, templateMatchRate: 0.2 }],
}), {
  passed: false,
  reason: "shadow_template_match_rate_below_threshold",
});
assert.deepEqual(assessResearchAgentRolloutQuality({
  metrics: [{ ...rolloutMetrics, reportGatePassed: false }],
}), {
  passed: false,
  reason: "shadow_report_gate_failed",
});

const accepted: AgentAction = {
  type: "call_tool",
  taskKey: "research",
  toolName: "deepResearch",
  arguments: { focus: "证据" },
  summary: "设计已完成，开始检索证据。",
};
const acceptedResult = validateResearchAgentAction({ action: accepted, tasks, completedStateKeys: ["design"] });
assert.equal(acceptedResult.accepted, true);
assert.equal(acceptedResult.task?.key, "research");

const wireCallToolParsed = parseResearchAgentAction({
  type: "call_tool",
  summary: "从 Provider wire schema 恢复任务参数。",
  taskKey: "research",
  toolName: "deepResearch",
  arguments: "{\"focus\":\"证据\"}",
  reason: "",
  requestedTasks: [],
  question: "",
  options: [],
  fields: [],
});
assert.deepEqual(wireCallToolParsed, {
  type: "call_tool",
  summary: "从 Provider wire schema 恢复任务参数。",
  taskKey: "research",
  toolName: "deepResearch",
  arguments: { focus: "证据" },
});
assert.equal(
  validateResearchAgentAction({ action: wireCallToolParsed, tasks, completedStateKeys: ["design"] }).accepted,
  true,
);

const mismatch: AgentAction = { ...accepted, toolName: "searchPersonas" };
const mismatchResult = validateResearchAgentAction({ action: mismatch, tasks, completedStateKeys: ["design"] });
assert.equal(mismatchResult.accepted, false);
assert.equal(mismatchResult.reason, "tool_mismatch");

const argumentsMismatch: AgentAction = { ...accepted, arguments: { focus: "改写任务输入" } };
const argumentsMismatchResult = validateResearchAgentAction({ action: argumentsMismatch, tasks, completedStateKeys: ["design"] });
assert.equal(argumentsMismatchResult.accepted, false);
assert.equal(argumentsMismatchResult.reason, "arguments_mismatch");

const replan: AgentAction = {
  type: "replan",
  summary: "补充一个反向证据检索任务。",
  reason: "当前来源缺少限制条件。",
  requestedTasks: [{
    key: "research_counterevidence",
    title: "补充反向证据",
    toolName: "deepResearch",
    template: "targeted_research",
    dependsOn: ["design"],
    input: { focus: "寻找反例与限制条件" },
  }],
};
const replanTasks = [...tasks, { key: "report", title: "Report", toolName: "generateReport", status: "pending", dependsOn: ["research"], input: {} }];
const replanResult = validateResearchAgentAction({
  action: replan,
  tasks: replanTasks,
  completedStateKeys: ["design"],
  availableToolNames: ["deepResearch", "searchPersonas"],
  maxDynamicTasks: 2,
});
assert.equal(replanResult.accepted, true);

const closedGateReplanResult = validateResearchAgentAction({
  action: replan,
  tasks: [...tasks, { key: "report", title: "Report", toolName: "generateReport", status: "completed", dependsOn: ["research"], input: {} }],
  completedStateKeys: ["design", "research", "report"],
  availableToolNames: ["deepResearch", "searchPersonas"],
  maxDynamicTasks: 2,
});
assert.equal(closedGateReplanResult.accepted, false);
assert.equal(closedGateReplanResult.reason, "report_gate_not_open");

const disallowedTemplateResult = validateResearchAgentAction({
  action: { ...replan, requestedTasks: [{ ...replan.requestedTasks[0], template: "social_signal_scan" }] },
  tasks: replanTasks,
  completedStateKeys: ["design"],
  availableToolNames: ["deepResearch", "scoutSocialTrends"],
  allowedTaskTemplates: ["targeted_research", "social_signal_scan"],
  maxDynamicTasks: 2,
});
assert.equal(disallowedTemplateResult.accepted, false);
assert.equal(disallowedTemplateResult.reason, "template_tool_mismatch");

const invalidTemplateInputResult = validateResearchAgentAction({
  action: { ...replan, requestedTasks: [{ ...replan.requestedTasks[0], template: "social_signal_scan", toolName: "scoutSocialTrends", input: {} }] },
  tasks: replanTasks,
  completedStateKeys: ["design"],
  availableToolNames: ["deepResearch", "scoutSocialTrends"],
  allowedTaskTemplates: ["targeted_research", "social_signal_scan"],
  maxDynamicTasks: 2,
});
assert.equal(invalidTemplateInputResult.accepted, false);
assert.equal(invalidTemplateInputResult.reason, "template_input_invalid");

const policyTemplateResult = validateResearchAgentAction({
  action: replan,
  tasks: replanTasks,
  completedStateKeys: ["design"],
  availableToolNames: ["deepResearch"],
  allowedTaskTemplates: ["social_signal_scan"],
  maxDynamicTasks: 2,
});
assert.equal(policyTemplateResult.accepted, false);
assert.equal(policyTemplateResult.reason, "template_not_allowed");

const legacyParsed = parseResearchAgentAction({
  type: "replan",
  summary: "兼容旧动作。",
  taskKey: null,
  toolName: null,
  arguments: null,
  reason: "补充证据。",
  requestedTasks: [{
    key: "legacy_research",
    title: "旧格式研究任务",
    toolName: "deepResearch",
    dependsOn: ["design"],
    input: { focus: "历史格式" },
  }],
  question: null,
  options: [],
  fields: [],
});
assert.equal(legacyParsed.type, "replan");
assert.equal(legacyParsed.type === "replan" ? legacyParsed.requestedTasks[0].template : null, "targeted_research");

const wireReplanParsed = parseResearchAgentAction({
  type: "replan",
  summary: "从 Provider wire schema 恢复动态任务。",
  taskKey: "",
  toolName: "",
  arguments: "{}",
  reason: "需要补充反向证据。",
  requestedTasks: [{
    key: "wire_research",
    title: "检索反向证据",
    toolName: "deepResearch",
    template: "targeted_research",
    dependsOn: ["design"],
    input: "{\"focus\":\"反例与限制条件\"}",
  }],
  question: "",
  options: [],
  fields: [],
});
assert.deepEqual(wireReplanParsed.type === "replan" ? wireReplanParsed.requestedTasks[0].input : null, {
  focus: "反例与限制条件",
});

assert.deepEqual(parseProviderSearchSourcePlan({
  queries: "[\"九号电动车用户\",\"electric scooter users\",\"二轮电动车市场\"]",
  seedUrls: "[\"https://example.com/product\",\"https://example.com/pricing\",\"https://example.com/privacy\",\"https://example.com/cases\"]",
}), {
  queries: ["九号电动车用户", "electric scooter users", "二轮电动车市场"],
  seedUrls: ["https://example.com/product", "https://example.com/pricing", "https://example.com/privacy", "https://example.com/cases"],
});
assert.deepEqual(parseProviderSearchSourcePlan({
  queries: ["九号电动车用户", "electric scooter users", "二轮电动车市场"],
  seedUrls: ["https://example.com/product", "https://example.com/pricing", "https://example.com/privacy", "https://example.com/cases"],
}), {
  queries: ["九号电动车用户", "electric scooter users", "二轮电动车市场"],
  seedUrls: ["https://example.com/product", "https://example.com/pricing", "https://example.com/privacy", "https://example.com/cases"],
});

const rejectedReplan = validateResearchAgentAction({
  action: { ...replan, requestedTasks: [{ ...replan.requestedTasks[0], toolName: "shell" }] },
  tasks: replanTasks,
  completedStateKeys: ["design"],
  availableToolNames: ["deepResearch"],
  maxDynamicTasks: 2,
});
assert.equal(rejectedReplan.accepted, false);
assert.equal(rejectedReplan.reason, "tool_not_allowed");

const forwardDependencyReplan = validateResearchAgentAction({
  action: {
    ...replan,
    requestedTasks: [
      { ...replan.requestedTasks[0], dependsOn: ["research_followup"] },
      {
        key: "research_followup",
        title: "补充验证",
        toolName: "deepResearch",
        dependsOn: ["design"],
        input: { focus: "验证反向证据" },
      },
    ],
  },
  tasks: replanTasks,
  completedStateKeys: ["design"],
  availableToolNames: ["deepResearch"],
  maxDynamicTasks: 2,
});
assert.equal(forwardDependencyReplan.accepted, false);
assert.equal(forwardDependencyReplan.reason, "dependency_unknown");

const askUser: AgentAction = {
  type: "ask_user",
  summary: "需要用户补充可信来源。",
  taskKey: "research",
  question: "请补充一个可信公开来源或进一步限定研究范围。",
  options: ["补充来源", "缩小范围"],
  fields: [{ key: "selectedOption", label: "处理方式", type: "choice", required: true, options: ["补充来源", "缩小范围"] }],
};
const askUserResult = validateResearchAgentAction({ action: askUser, tasks, completedStateKeys: ["design"] });
assert.equal(askUserResult.accepted, true);
assert.equal(askUserResult.task?.key, "research");

const unsupportedAskUserResult = validateResearchAgentAction({
  action: { ...askUser, fields: [{ key: "shellCommand", label: "命令", type: "text", required: true }] },
  tasks,
  completedStateKeys: ["design"],
});
assert.equal(unsupportedAskUserResult.accepted, false);
assert.equal(unsupportedAskUserResult.reason, "input_field_not_supported");

const inputRequest = parseTaskInputRequest({
  title: "补充研究输入",
  description: "选择下一步并补充来源。",
  fields: [
    { key: "selectedOption", label: "下一步", type: "choice", required: true, options: ["补充来源", "缩小范围"] },
    { key: "sourceUrls", label: "公开 URL", type: "url_list", required: false, maxItems: 2 },
  ],
});
assert(inputRequest);
assert.deepEqual(validateTaskInputResponse(inputRequest, {
  selectedOption: "补充来源",
  sourceUrls: ["https://example.com/source"],
}), {
  success: true,
  data: { selectedOption: "补充来源", sourceUrls: ["https://example.com/source"] },
});
assert.equal(validateTaskInputResponse(inputRequest, { selectedOption: "任意输入" }).success, false);
assert.equal(validateTaskInputResponse(inputRequest, { selectedOption: "缩小范围", shellCommand: "pwd" }).success, false);
assert.equal(validateTaskInputResponse(inputRequest, { selectedOption: "补充来源", sourceUrls: ["file:///etc/passwd"] }).success, false);

const parsedAskUser = parseResearchAgentAction({
  type: "ask_user",
  summary: "需要用户选择下一步。",
  taskKey: "research",
  toolName: null,
  arguments: null,
  reason: null,
  requestedTasks: [],
  question: "请选择处理方式。",
  options: ["补充来源", "缩小范围"],
  fields: [{
    key: "selectedOption",
    label: "处理方式",
    type: "choice",
    required: true,
    maxLength: null,
    maxItems: null,
    options: ["补充来源", "缩小范围"],
  }],
});
assert.equal(parsedAskUser.type, "ask_user");
assert.deepEqual(parsedAskUser.type === "ask_user" ? parsedAskUser.fields[0].options : [], ["补充来源", "缩小范围"]);

const mixedReadyTasks = [
  { ...tasks[1], key: "report", toolName: "generateReport" },
  tasks[1],
];
const compatibleAskUserResult = validateResearchAgentAction({
  action: askUser,
  tasks: mixedReadyTasks,
  completedStateKeys: ["design"],
  availableToolNames: ["deepResearch", "scoutSocialTrends"],
});
assert.equal(compatibleAskUserResult.accepted, true);
assert.equal(compatibleAskUserResult.task?.key, "research");

const finish: AgentAction = { type: "finish", summary: "提前结束" };
const finishResult = validateResearchAgentAction({ action: finish, tasks, completedStateKeys: ["design"] });
assert.equal(finishResult.accepted, false);
assert.equal(finishResult.reason, "required_tasks_incomplete");

const completedTasks = tasks.map((task) => ({ ...task, status: "completed" }));
const completedFinish = validateResearchAgentAction({ action: finish, tasks: completedTasks, completedStateKeys: ["design", "research"] });
assert.equal(completedFinish.accepted, true);

console.log("research-agent-controller smoke passed");
