# Agent Architecture Research

日期：2026-08-18

## 结论

当前 `/study/[publicId]` 是一个 Plan-and-Execute research harness，不是完全自主 Agent：研究计划先编译成 `study_tasks` DAG，worker 按依赖执行，`reasoning-runtime.ts` 只在固定检查点用确定性规则决定是否追加少量研究任务。

要还原“特赞平台 Agent”式体验，不应该移除 harness，也不应该把所有安全约束交给模型。推荐的目标结构是：

```text
用户目标
  -> Agent Controller（模型决定下一步）
  -> Harness（校验、排队、执行、恢复、预算、审计）
  -> Skill / Tool
  -> 结构化结果 + 事件流
  -> Agent Controller 继续决策
```

一句话：不是把系统换成另一个框架，而是把固定任务图逐步升级为“模型提出、Harness 执行”的动态 ledger；Harness 仍是受治理的执行内核。

生产架构决策见 `docs/agent-architecture-adr-001.md`。该 ADR 明确暂不引入 LangGraph，并规定所有动态任务必须通过唯一的 Plan Mutation Service 写入 ledger。

这里的 “Harness” 如果你说的是执行治理层，不需要替换成新的 “Hermes/Herness” 产品或 SDK。当前仓库已经有 Harness、Skill Gateway、租约队列、checkpoint 和 SSE，直接迁移会造成两套状态模型。

关于是否基于 Hermes 类开源项目二次开发，见 `docs/hermes-harness-decision.md`。当前决策是保留本项目 Harness，只在明确缺口上隔离引入局部组件。

## 研究后执行状态

本次先完成文档和 Phase 1 的最小实现，再保留旧 DAG 作为可回退路径：

- `RESEARCH_AGENT_CONTROLLER_MODE=off`：默认确定性 DAG，不调用 Controller。
- `shadow`：调用 Controller、记录 `agent.*` 事件，但仍执行正常 ready wave，用于比较决策质量。
- `active`：执行通过 Harness 校验的 `call_tool`、`replan` 和研究任务 `ask_user`；`finish` 仍由必需任务和报告契约决定，模型不能提前终止运行。
- 证据不足时的动态补充仍由 `reasoning-runtime.ts` 按来源、域名、冲突、预算和动态任务上限决定，不由模型直接插入 SQL。

因此当前不是“完全自主 Agent”，而是可以灰度的 Agent Controller + deterministic Harness。Phase 2 已具备受控动态 ledger，但在完成恢复、质量、成本和安全评估前，仍不应把 `active` 设为默认策略。

## 现状证据

### Study 研究执行

- `src/lib/research-harness.ts:935` 的 `createResearchTaskPlan()` 会根据研究类型和方法预先生成整张任务图。
- `src/lib/research-harness.ts:2088` 开始的运行循环只从 `dependsOn` 已满足的任务中取 ready wave，然后执行固定任务。
- `src/lib/reasoning-runtime.ts:164` 的 `evaluateReasoningCheckpoint()` 根据来源数量、域名数量、冲突度、预算等代码规则选择 `continue`、`append_task`、`stop_expansion` 或 `finish_run`。
- `src/lib/openai-provider.ts` 的研究 Controller 已使用 Responses API 的 `stream=true`；流式 JSON 片段只在最终结构化校验后转成安全摘要，Chat Completions 路由明确标记为 non-streaming。
- `study_events` 已经提供了很好的审计基础，但之前主要在任务开始/完成后写入事件。

因此，图中 `analyzeBrief`、`resolveIntentContract`、`makeStudyPlan` 等卡片是计划对象的呈现，不等价于模型实时选择工具。

### Universal Agent

`src/lib/universal-agent.ts:722` 已有更接近目标的循环：每一轮读取上下文，调用模型决定一个动作，执行工具，再把工具结果放回下一轮上下文，直到 `finish` 或达到步数上限。

它仍然缺少本次目标所需的两点：

1. 决策和工具调用没有通过 SSE 向当前 UI 增量输出。
2. 研究专用的 `study_tasks`、artifact、checkpoint、Context 绑定和研究报告契约还没有接入这个循环。

## 目标行为

目标不是显示隐藏 Chain-of-Thought。生产 Agent 不应把模型私有推理原文直接展示给用户；应该流式展示可审计的过程事件：

- `agent.turn.started`
- `agent.decision.summary.delta`
- `tool.call.started`
- `tool.call.progress`
- `tool.call.completed`
- `agent.checkpoint`
- `agent.turn.completed`
- `agent.run.waiting_input` / `agent.run.failed`

用户看到的是“为什么选择这个工具”的短摘要、工具参数、工具运行状态、结果摘要和下一步决策，而不是未经审核的内部思维链。

## 推荐技术路线

### 1. 保留 Harness

Harness 继续拥有以下不可绕过的职责：

- Skill 版本锁定和 capability grant 校验
- 任务幂等、重试、超时、取消、租约和 checkpoint
- Context policy、来源快照、artifact 和 evidence graph
- Token/时间/并发预算
- 所有决策和工具调用的事件审计

模型只能提出动作，不能直接写数据库、绕过 Skill gateway 或自行改变权限。

### 2. 新增 Agent Controller

在 `research-harness.ts` 上方新增研究专用 controller，输入当前研究状态和可用 Skill catalog，输出严格的动作联合类型：

```ts
type AgentAction =
  | { type: "call_tool"; toolName: ResearchToolName; arguments: Record<string, unknown>; summary: string }
  | { type: "replan"; reason: string; requestedTasks: Array<{ toolName: ResearchToolName; arguments: Record<string, unknown> }> }
  | { type: "ask_user"; taskKey: string; question: string; fields: TaskInputField[] }
  | { type: "finish"; summary: string };
```

Controller 每一轮只提出一个动作。Harness 对动作执行二次校验：工具是否存在、参数是否符合 Zod schema、依赖/权限/预算是否满足、是否超过步数和动态任务上限。校验失败时不执行工具，而是把拒绝原因作为结构化结果返回给下一轮。

### 3. 任务图从“预编译 DAG”改为“能力图 + 动态 ledger”

不再把所有后续步骤一次性当成必做任务。保留少量硬约束：

- 研究计划和用户确认是启动门槛。
- 最终报告必须满足 evidence、citation、judge 和 finalize 契约。
- 每个 Skill 都有明确输入/输出 schema。

其余任务由 Controller 根据已完成 artifact、证据缺口和用户目标动态加入 `study_tasks`，统一标记现有的 `origin = 'dynamic'`。这样仍可恢复、回放和审计，但不再把“先做哪四步”写死成唯一路径。

### 4. 使用 Responses API 的语义事件流

OpenAI 官方文档将 Responses API 定位为构建动态 Agent 的核心 API，并提供 typed SSE 事件；流式 function call 会产生参数增量和完成事件。项目当前 Provider wrapper 应新增专用 streaming 方法，而不是把结构化 JSON 的最终结果伪装成流：

- Responses API：由应用自己掌控循环、工具路由和分支。
- Agents SDK：由 SDK 管理 Agent loop、tracing、guardrails 和 resumable state。

本项目已有自定义 Postgres harness、Skill gateway、租约和恢复机制，因此选择 Responses API + 自有 Controller 更合适；直接迁移 Agents SDK 会产生两套状态和恢复模型。

兼容 DeepSeek/Chat Completions 的路由仍可保留，但必须明确标记为 `non_streaming_provider` 或实现对应的增量适配，不能把非流式响应宣称为 Token 流。

### 5. 事件流与 UI

保留 `/api/studies/[publicId]/events` SSE endpoint，增加：

- `Last-Event-ID` 断线续传
- 单调 event id 和 run 过滤
- 事件 payload schema/version
- UI 只消费可审计摘要，不消费隐藏 reasoning

`StudyAgentWorkspace` 应从“router.refresh 后重新投影”升级为“本地事件 store + 低频 server refresh”：

- 工具开始、调用参数、进度和完成立即进入时间线。
- artifact、任务状态和报告仍通过 server refresh 获取权威快照。
- 页面刷新、断线重连和回放都从 `study_events` 恢复。

## 分阶段执行

### Phase 0：文档和契约（已完成）

- 固化 AgentAction、事件类型、拒绝原因、预算和终止条件。
- 默认仍为 `RESEARCH_AGENT_CONTROLLER_MODE=off`，不改变既有研究运行行为。

### Phase 1：流式 Controller 骨架（已完成，可灰度）

- 新增 `research-agent-controller.ts`。
- 为 Responses API 增加 typed streaming adapter。
- 将 Controller 的决策、工具开始/完成和摘要增量写入 `study_events`。
- 旧 DAG runner 继续作为 fallback；`shadow` 和 `active` 均可按环境变量开启。

### Phase 2：动态 ledger（已完成首个受控版本）

- `replan` 可以在报告生成前追加内置 Skill 任务；首版动态工具白名单仅包含 `deepResearch` 和 `scoutSocialTrends`，Persona、讨论与报告工具不能由 Agent 动态追加。Harness 校验 key、工具白名单、Zod 输入、依赖顺序、动态任务额度，并锁定 Skill 版本。
- deterministic reasoning 和 Agent `replan` 已统一通过 `research-task-mutation.ts` 写入动态任务；该服务在事务内锁定 run，并根据数据库当前状态重新校验额度、依赖、工具白名单和插入 gate。
- 被接受的 Agent `replan` 会写入 `reasoning_decisions`，新增任务通过 `reasoning_decision_id` 关联决策，可在运行回放中解释任务来源。
- `ask_user` 复用 `study_task_inputs` 和 `waiting_input` 恢复链路，目前仅用于支持 `resumeInput` 的 `deepResearch` / `scoutSocialTrends` 任务。Controller 可声明 `focus`、`sourceUrls`、`selectedOption` 三类受控字段；UI 按字段渲染，服务端依据持久化的原请求校验后才恢复任务。
- `study_tasks` 同时承载计划任务和 `origin = 'dynamic'` 的 Agent 任务，成为可恢复执行 ledger。
- `finish` 继续由 Harness 的必需任务和报告 gate 控制，不能由模型提前绕过。
- 保留报告、证据和合规硬门槛。

### Phase 3：研究 UI 切换

- `/study` 默认显示 Agent Controller 事件流。
- 计划图、动态任务、工具参数、拒绝原因和 checkpoint 可回放。
- 运行历史同时标记 `agent_controller` 和 fallback harness 版本。

### Phase 4：评估和灰度

- 用现有 `agent-evals` 和 research smoke tests 比较旧 DAG 与 Agent Controller：完成率、来源覆盖、报告契约、Token、延迟、动态任务数量。
- 先按 workspace/strategy 灰度，出现 schema、预算、恢复或审计异常时自动 fallback 到旧 runner。

当前已完成 Phase 4 的第一步：`research-agent-evaluation.ts` 从 `study_events`、`study_tasks` 和运行 usage 重建并持久化 trajectory summary。指标包括 Controller 失败率、策略拒绝率、工具选择匹配率、replan 数量、动态任务数、来源/域名增益、Token、决策延迟、重试、租约恢复、人工介入和 report gate；完成运行会自动写入 `research_agent_trajectory_evaluations`，运行回放也会带出该摘要。该评估器只读审计状态，不改变执行权限，默认仍保持 `off`，适合先按 workspace/strategy 做 `shadow` 对照。

Phase 4 的第二步已加入 rollout resolver：策略配置请求 `active` 时，最近至少 3 个同 workspace/strategy 的轨迹样本必须满足 Controller 失败率不高于 10%、策略拒绝率不高于 60%、工具选择匹配率不低于 80%、模板接受率不低于 80%，且 report gate 全部通过，否则自动降级到 `shadow`。阈值可通过策略 config 覆盖（`agentControllerShadowMinRuns`、`agentControllerMaxFailureRate`、`agentControllerMaxRejectRate`、`agentControllerMinCallToolMatchRate`、`agentControllerMinTemplateMatchRate`），降级原因会写入 run 事件，便于审计。

## 不建议的做法

- 不建议直接删除 `createResearchTaskPlan()` 和所有依赖检查。
- 不建议把整个研究流程改成“模型输出一段 JSON，然后服务器照做”。必须保留动作白名单、schema 校验和二次策略校验。
- 不建议直接把 Agents SDK 引入现有 worker。当前数据库已经有一套运行、租约、重试、artifact 和事件模型，直接并行维护 SDK session 会造成状态分裂。
- 不建议展示原始 Chain-of-Thought。显示短的 decision summary 和工具生命周期即可实现特赞式可见过程，同时保留安全和审计边界。

## 下一阶段实现：Capability Templates

动态任务已进一步收敛为版本化 capability template，而不是让模型直接组合任意
`toolName + input`。当前目录由 `src/lib/research-agent-templates.ts` 管理，首批
包含 `targeted_research`（`deepResearch`）和 `social_signal_scan`
（`scoutSocialTrends`）。策略可以通过 `agentControllerAllowedTemplates` 缩小集合。
Controller 负责首次校验，Harness 的 mutation 入口负责事务前二次校验；模板、版本、
工具和输入 schema 会进入 reasoning decision 与运行事件，便于审计、回放和离线评估。
这一步不改变 Harness、Responses API 或 rollout 策略，也不引入 LangGraph。

## 验收标准

一次真实研究运行应满足：

1. 用户能在工具真正开始时看到工具事件，而不是等任务完成后才看到卡片。
2. 模型可以根据前一个工具结果选择不同的下一工具，路径不再由完整固定 DAG 决定。
3. 每个模型动作都能追溯到输入快照、决策摘要、工具参数、工具结果、预算和 policy 拒绝原因。
4. Worker 中断后可以从最后一个 checkpoint 继续，不重复产生已完成 artifact。
5. Token 流、工具参数流和最终结构化结果的事件顺序可通过 `Last-Event-ID` 断线恢复。
6. 报告证据、引用、Persona 合成和合规限制仍由 Harness 的硬契约守护。

## 参考

- OpenAI Agents SDK：<https://developers.openai.com/api/docs/guides/agents>
- OpenAI Streaming API responses：<https://developers.openai.com/api/docs/guides/streaming-responses>
- OpenAI Function calling：<https://developers.openai.com/api/docs/guides/function-calling>
- OpenAI Building agents：<https://developers.openai.com/tracks/building-agents>
