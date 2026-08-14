# atypica.AI / GEA 架构恢复审计

日期：2026-08-14

## 结论

当前仓库与原 atypica.AI 的“产品方向”一致，但不是同一套技术架构的完整还原。

当前代码已经具备：

- Next.js 16 App Router + TypeScript 的 Web/API 层。
- Supabase/PostgreSQL 数据层、workspace 成员隔离和 RLS 读取策略。
- 研究计划确认、可恢复的 Plan-and-Execute harness、工具调用记录、checkpoint、artifact、租约队列和 SSE 事件。
- 两类访谈入口：AI 合成访谈和公开链接真人访谈。
- Persona / Panel / Interview / Report 的研究对象模型。

当前代码尚未形成独立的：

- 意图解析服务边界（目前主要由 study plan 与本地规则/Provider 调用承担）。
- 可跨业务线复用的编排 Runtime（目前 `research-harness.ts` 是研究产品专用 Runtime）。
- Skill Gateway（没有版本化 manifest、能力注册、权限、输入输出契约和安装/发布生命周期）。
- Context System（没有统一的 context asset、版本、chunk、embedding、实体/本体关系和检索 API）。
- 多 Agent 并行调度、限流、实验分组和策略评估闭环。

因此，用户提出的四层架构是适合作为恢复目标的目标架构，但不能被描述为当前仓库已经实现。

## 证据分级

### 公开站点可以确认的事实

对 `https://atypica.ai/` 的公开 HTML 和内嵌文案审计显示，产品公开暴露过以下概念：

- Universal Agent / Universal AI Workspace。
- My Skills、Upload Skill、`.skill` / `SKILL.md` 导出与安装语义。
- Core memory、Working memory、Team Memory、Context Interview。
- Subjective World Model、AI Persona、Panel、AI Interview、Insight Radio、AI Sage。
- Personal 和 Team API keys，说明存在对外程序化访问的产品意图。

这些证据证明“Skill + Memory/Context + 多产品线 Agent”是原产品公开定位的一部分；它们不能证明原私有服务的具体语言、队列产品、向量数据库或部署拓扑。

### 当前仓库可以确认的事实

`src/lib/research-harness.ts` 已实现研究专用工具注册表、依赖任务、幂等 invocation、checkpoint、artifact、job lease 和重试；但 `runStudyHarness` 按 position 串行执行任务，且队列默认一次处理一个 job。

`src/lib/interviews.ts` 已同时支持 `ai` 与 `human` session，但 AI 访谈 run 仍是单个项目级任务，不是面向队列的多 Agent 调度系统。

`supabase/migrations/20260813030000_research_harness.sql` 已有任务、调用、artifact、checkpoint、job queue 表；没有 context asset/version/chunk/embedding、skill manifest/version 或实验分组表。

### 无法从公开资料还原的事实

原私有源码、历史数据库、Provider 配置、真实 Prompt、模型路由、训练数据、Subjective World Model 的训练/推理实现均不可从公开部署确定。恢复时必须保留证据边界，不能把推测写成原实现。

## 目标架构

```text
API / Web / MCP clients
          |
  Intent + Policy Service
          |
  Orchestration Runtime
  (DAG, durable state, retries, leases, parallelism, rate limits, experiments)
       /       |        \
 Skill Gateway  Context System  Provider Gateway
       |             |
 versioned skills  assets/versions/chunks/embeddings/ontology/behavior signals
```

四层的职责应保持独立：

1. **意图解析**：把自然语言目标转换成有版本的任务规格、约束、预算、数据范围和安全策略。
2. **编排 Runtime**：执行通用 DAG/状态机；研究、市场洞察、产品调研只是不同 workflow/skill 组合。
3. **Skill Gateway**：只暴露经过注册、版本锁定、权限检查和 schema 校验的能力；Provider SDK 不应直接散落在业务组件中。
4. **Context System**：管理长期/工作记忆、研究样本、原始资料和行为信号的版本化来源，并提供可审计检索结果。

## 分阶段恢复建议

### P0：先修正确性和边界

- 保留现有 harness，抽出 `Runtime`、`SkillDefinition`、`ContextProvider` 的最小接口。
- 在迁移后验证 `study_personas.workspace_id` 已存在（现有 persona library migration 已补齐，但要在部署环境执行完整迁移链）。
- 给所有任务、artifact、provider 调用记录 `run_id`、prompt/skill/context 版本和 trace id。
- 不在这一阶段引入“世界模型训练”或无验收标准的向量召回。

### P1：Skill Gateway + Context MVP

- [x] 建立 skill manifest/version 和 context asset/version/chunk/edge 的持久化契约。
- [x] 增加 Skill 注册、版本发布、输入输出 schema、workspace 权限和审计事件 API。
- [x] 增加 Context 资产创建、版本发布和 PostgreSQL 关键词/元数据检索；结果带 source/version/chunk citation。
- [x] 研究 Runtime 锁定内建 Skill 版本和 Context retrieval，并将引用事件写入研究时间线。
- [ ] 增加 Skill 启停、声明式执行器或受控沙箱；当前上传的 workspace Skill 仅保存契约，不执行任意代码。
- [ ] 增加可替换 embedding provider 和向量索引；当前策略为 `lexical_metadata_v1`。
- 将团队 core memory、用户 profile、研究项目 working memory 统一映射为 context assets。

### P2：通用 Runtime 和调度

- [x] 将串行 `runStudyHarness` 改为依赖就绪的 DAG wave；同层任务按受控并发执行。
- [x] 增加 per-workspace/provider run slot、每 workspace/provider RPM、任务超时和 run 总超时。
- [x] 增加持久化取消请求、Provider AbortSignal、排队即时取消和 SSE 终止事件。
- [x] 增加 `realtime_agent` / `batch_research` workflow 类型与 workflow/strategy version 追踪。
- [x] 增加实验、variant、稳定加权分配、每 run assignment 与基础结果指标。
- [x] variant 可调整 task concurrency、task/run timeout 和受限 `instructionSuffix`，用于比较访谈/分析策略。
- [x] 实时在线访谈 Agent 已迁入持久化状态机，支持逐轮 Provider 调用、刷新恢复、幂等重试、超时与取消。
- [x] 实时会话固定内建 Skill、策略版本和 Context retrieval，并提供版本回放 API/UI。
- [x] 增加六维人工质量评分，以及完成率、时长、Token、轮数和质量分的实验聚合。
- [x] 增加跨 variant 的并排 replay 对比：可比较完成率、时长、Token、轮数、人工质量，并检查 Workflow/Skill/Strategy/Context/Prompt/Provider 和完整 transcript。
- [x] 增加版本化 `ReasoningDecision`、候选动作、coverage/conflict/novelty/budget 指标和真实 artifact/evidence 输入引用。
- [x] 支持白名单动态研究任务追加；动态任务复用现有 invocation、artifact、checkpoint、timeout、cancel 和恢复语义。
- [x] 增加扩展上限、Token 预算与证据覆盖停止条件；停止扩展不跳过报告等固定必需任务。
- [x] 研究回放展示动态任务代次、选择动作、决策理由、策略版本和预算快照。
- [x] 增加真实 Public Web Connector Run、候选来源、robots/公开网络合规检查、不可变正文快照和标准化 Observation。
- [x] Tavily/Bing 仅负责发现候选；只有直接公开采集成功并产生 hash 的页面正文才进入 Evidence，搜索摘要不再直接充当事实证据。
- [x] 增加 task 尝试历史、持久化错误分类与指数退避；可重试失败在同一 run 内继续，不新建 artifact 或 invocation。
- [x] 增加 `waiting_input` 暂停/恢复契约；公开网页来源不足会请求补充研究焦点或可信 URL，并从原 checkpoint 恢复。
- [x] Worker 租约过期时将遗留 task attempt 标为 `interrupted`，重置任务为 pending；完成的 checkpoint/artifact 保持不变。
- [x] 增加来源拒绝/不可用/下架状态、内容 hash 去重、快照引用和 Scout Console 审计视图。
- [x] 增加逐题覆盖率、追问命中率，以及批量工具调用/失败/重试指标；session 快照和 experiment 聚合均可回放。

### P3：多产品线与世界模型

- 通过稳定 API/MCP 暴露 research、market insight、product research workflow。
- 只有在具备合法、可追溯的研究样本和离线评估集后，才实现 Subjective World Model 的训练/蒸馏/评估；它不是简单增加一个 embedding 表。

## 是否需要现在加 Skills / Context

需要加“边界和数据契约”，不需要现在伪造完整能力。

- Skills：现在加 manifest/version/权限/schema/审计，后续再接上传 `.skill`、沙箱执行和发布市场。
- Context：现在加资产版本、来源、chunk、关系和检索接口；先用可解释的关键词/元数据检索，embedding 作为可替换实现。
- 多 Agent：现有 queue/checkpoint 是基础，但在并发 claim、限流、实验分组补齐前，不应宣称已支持。

## P1 已实现接口

- `GET /api/skills`：列出可执行内建 Skill 与工作区 Skill manifest。
- `POST /api/skills`：创建不可执行的工作区 Skill manifest v1。
- `POST /api/skills/:publicId/versions`：发布新的 Skill 契约版本。
- `GET /api/context`：列出当前用户可见的 Context assets。
- `POST /api/context`：创建资产、首版本与确定性 chunks。
- `POST /api/context/:publicId/versions`：发布不可变新版本并切换 current version。
- `POST /api/context/search`：执行带持久化 retrieval/items 的可审计检索。

安全边界：`private` Skill 只对 owner 可见；`user` Context 只对创建者可见；其他 workspace 资源要求 workspace membership。服务端数据库连接仍负责写入，浏览器 authenticated role 只有读取授权。

## P2 已实现接口

- `POST /api/studies/:publicId/cancel`：请求取消当前研究 run；排队任务立即取消，执行中任务由 worker 收敛。
- `GET /api/experiments`：列出 workspace 策略实验与 variants。
- `POST /api/experiments`：管理员创建 draft 实验。
- `POST /api/experiments/:publicId/status`：启用、暂停或结束实验；同 workspace/workflow 只保留一个 active 实验。
- `GET /api/experiments/:publicId/comparison`：列出 realtime variants、聚合指标和候选会话；可用 `leftSession` / `rightSession` 并行加载两场授权回放。

Runtime 默认值：每 run 2 个并发 task、每 workspace 2 个活跃研究 run、每 provider 4 个活跃研究 run、每 workspace/provider 每分钟 30 个 Provider 任务。均可通过 `RESEARCH_*` 环境变量调整并在代码中限制上下界。

## P3 前置已实现接口

- `POST /api/interview-invitations/:token/realtime`：创建持久化实时访谈会话并固定首个研究问题。
- `GET /api/interview-invitations/:token/realtime/:sessionPublicId`：用高熵 resume token 恢复会话。
- `POST /api/interview-invitations/:token/realtime/:sessionPublicId/turn`：幂等提交参与者回答并生成追问、下一题或结束语。
- `DELETE /api/interview-invitations/:token/realtime/:sessionPublicId`：取消实时访谈并记录实验指标。
- `GET /api/interviews/:publicId/sessions/:sessionPublicId/replay`：回放 workflow、Skill、Prompt、Context、策略和 Provider response 元数据。
- `POST /api/interviews/:publicId/sessions/:sessionPublicId/reviews`：保存相关性、深度、追问、一致性、证据约束和安全合规评分。

兼容边界：公开邀请页明确提供“Agent 对话”和“传统问卷”两种模式；原有静态问卷提交接口、AI Persona 批量合成访谈和历史消息角色均保留。

## 2026-08-13 部署与验收记录

- 远端 Supabase 已在单事务内应用 `20260813040000` 至 `20260813080000`；迁移前后 1 个访谈项目、2 场访谈、24 条消息和 6 个研究记录均保持不变。
- 真实 Provider 实时访谈 smoke 通过：4 次 Provider 调用、4 个 Provider turn、9 条 Agent/参与者交替消息；Workflow、Skill、Strategy、Context retrieval 和 Prompt version 均可回放，测试项目在 `finally` 中删除。
- `/interview/experiments` 已提供实时实验指标和双会话版本回放；远端当前没有实验时显示明确空状态。
- 隔离 PostgreSQL 15 已验证完整迁移链和实验比较：两个 variants 各 1 个 assignment，指标映射、候选会话、3 条回放消息、Context citation 与人工 review 均通过，临时容器已删除。
- 可重复命令：`REALTIME_INTERVIEW_SMOKE_CONFIRM=1 pnpm smoke:realtime-interview`（会调用真实 Provider）和 `EXPERIMENT_COMPARISON_SMOKE_CONFIRM=1 pnpm smoke:experiment-comparison`（只允许本地数据库）。

## 2026-08-14 可信证据链部署与验收记录

- 远端 Supabase 已在单事务内应用 `20260813090000_evidence_claim_report_graph.sql`；迁移前后 6 个研究和 5 份报告保持不变，历史报告不做推测性证据回填。
- 新报告以 `reports.current_version_id` 指向不可变 `report_versions`，并由有序 `report_nodes`、`claims`、`evidence_sources/items` 和 `claim_evidence` 组成可信证据链。
- Provider 只能引用服务端给出的受控 evidence ref；非法引用会被过滤，没有有效引用的 finding 强制降级为低置信 `model_inference`。
- 公开分享会对真人访谈 evidence 做服务端脱敏，移除原文、source URI 和 locator；AI 合成模拟继续明确标注，不能伪装成真人样本。
- 隔离 PostgreSQL 15 已验证完整迁移链、同 run 幂等、10 个有序报告节点、3 条 Claim、4 个 Evidence Source/Item、3 条 Claim Evidence、公开脱敏和 legacy 兼容。
- 可重复命令：`EVIDENCE_GRAPH_SMOKE_CONFIRM=1 pnpm smoke:evidence-graph`，并且仅允许连接 localhost / `127.0.0.1` 数据库。

## 2026-08-14 动态 Reasoning Runtime 部署与验收记录

- 远端 Supabase 已应用 `20260814010000_reasoning_decisions_dynamic_tasks.sql`；迁移前后 6 个研究、5 份报告和 21 个既有任务保持不变，历史运行不伪造决策回填。
- `research-dag-v3-dynamic` 在稳定 checkpoint 运行确定性策略：记录候选动作后，可选择继续固定 DAG、追加受控任务、停止扩展或结束运行。
- 动态任务仅允许使用内建研究工具模板，并记录 originating decision、generation 和依赖；相同 completed-task checkpoint 通过 decision key 幂等复用，不重复追加任务。
- 隔离 PostgreSQL 15 smoke 验证 3 条决策、12 个候选动作、1 个动态任务和 3 条事件；恢复重放复用同一 decision public ID，gate 依赖、任务上限停止与 terminal finish 均通过。
- 浏览器发现并修复新增 join 后 `study_tasks.public_id` 的 SQL 歧义；修复后桌面和 390×844 移动端均显示 3 张决策卡、动态任务代次、coverage/conflict/novelty/budget，且无横向溢出或 console 错误。
- 可重复命令：`REASONING_RUNTIME_SMOKE_CONFIRM=1 pnpm smoke:reasoning-runtime`，仅允许连接 localhost / `127.0.0.1` 数据库。

## 2026-08-14 Scout Connector 与来源快照部署记录

- 远端 Supabase 已应用 `20260814020000_source_connector_snapshots.sql`；迁移前后 6 个研究、5 份报告和 21 个既有任务保持不变，历史 Run 不伪造候选、快照或 Observation 回填。
- `source_connector_runs`、`source_candidates`、`source_snapshots`、`source_observations` 形成 `Connector Run -> Candidate -> Snapshot -> Observation` 审计链；快照和 Observation 禁止更新，下架通过新 tombstone 快照表达。
- Tavily/Bing/seed URL 统一进入受控采集：仅允许 HTTP(S) 公网目标，逐跳校验重定向，检查 robots、正文类型、响应大小、登录/付费墙/CAPTCHA 提示，并且不发送认证 Cookie。
- 报告 Evidence locator/metadata 保存 Connector Run、Candidate、Snapshot、Observation、content hash 和采集时间；Scout Console 展示候选、成功快照、拒绝/不可用原因和 hash 前缀。
- 隔离 PostgreSQL 15 完整迁移链 smoke 验证 1 个 Run、8 个候选、4 个状态快照、2 个 Observation，以及 robots 拒绝、私网重定向拦截、重复内容 hash、不可变快照、下架 tombstone 和 Evidence 引用。
- 可重复命令：`SOURCE_CONNECTOR_SMOKE_CONFIRM=1 pnpm smoke:source-connector`，仅允许连接 localhost / `127.0.0.1` 数据库。

## 2026-08-14 Task Recovery 与等待输入部署记录

- 远端 Supabase 已应用 `20260814030000_task_recovery_waiting_input.sql`；增加 `study_task_attempts` 和 `study_task_inputs`，历史 task 不做虚构尝试记录回填。
- task 失败按 cancellation、timeout、rate limit、upstream/response、input required、configuration/validation 分类；仅短暂性错误按持久化退避重试，未知错误保守终止。
- `PUBLIC_WEB_SOURCES_INSUFFICIENT` 进入 `waiting_input`，用户可在研究回放里提交补充焦点/公开 URL；运行、研究和 job 同时回到同一个 run 的 queued 状态。
- job 重新领取过期租约时，`running` task/invocation/attempt 标为 interrupted，再复用既有 checkpoint；artifact 以 `(run_id, task_id, artifact_type)` 幂等 upsert。
- 隔离 PostgreSQL 15 smoke 覆盖 2 次 task attempt、1 个 artifact、waiting input resume、lease recovery 和 terminal 分类：`TASK_RECOVERY_SMOKE_CONFIRM=1 pnpm smoke:task-recovery`。

## 2026-08-14 访谈与批量运行指标部署记录

- 新增 `interview_session_metrics`，以 session 唯一快照保存问题总数、已回答问题数、覆盖率、追问请求/回答数、追问命中率和 substantive answer 数；不回填历史 session。
- 实时访谈完成、超时失败或取消时物化快照，并将主要数值幂等 upsert 到 `strategy_metrics`；Replay API 返回同一份指标。
- 批量研究终态统计 `study_tool_invocations`、`study_task_attempts` 的调用、失败、重试和重试率，写入 assignment 指标；同 assignment 重跑不会产生重复 metric 行。
- `/interview/experiments` 的 Variant 表新增覆盖率、追问命中率和重试列，双侧 Replay 显示 session 级覆盖/追问/任务重试。
- 隔离数据库 smoke：`INTERVIEW_METRICS_SMOKE_CONFIRM=1 pnpm smoke:interview-metrics`，仅允许连接 localhost / `127.0.0.1`。

## 验收标准

- 任意一次运行可以重放：workflow、skill version、prompt version、context version、provider model 均可定位。
- 任意报告结论都能追溯到 artifact、访谈 session 或 context source。
- 同一 workspace 的 context/skill 不能跨租户泄露。
- 实时与批量 workflow 共用 Runtime，但可以独立设置超时、并发和预算。
- 策略实验可按实验组比较完成率、成本、响应质量和人工复核结果。
