# atypica.AI / GEA 架构恢复审计

日期：2026-08-15

## 结论

当前仓库与原 atypica.AI 的“产品方向”一致，但不是同一套技术架构的完整还原。

当前代码已经具备：

- Next.js 16 App Router + TypeScript 的 Web/API 层。
- Supabase/PostgreSQL 数据层、workspace 成员隔离和 RLS 读取策略。
- 研究计划确认、可恢复的 Plan-and-Execute harness、工具调用记录、checkpoint、artifact、租约队列和 SSE 事件。
- 两类访谈入口：AI 合成访谈和公开链接真人访谈。
- Persona / Panel / Interview / Report 的研究对象模型。
- 版本化 Skill Gateway、工作区启停、不可变 Run Binding、受控 HTTP/MCP executor 与执行审计。
- 版本化 Context Asset/Chunk/Edge、混合检索、Retrieval Snapshot、重建索引与离线评估；Reasoning 可按不足、冲突或时效条件生成有上限的动态 Context 刷新并回放。
- 版本化 `research-intent-v1`、确认版 Plan、编译后 `workflow-definition-v1` 与 Run 的不可变绑定；Intent Planning 使用 purpose-bound Context Snapshot。
- DAG wave、多层限流、租约恢复、策略实验、实时与批量两类工作流。

当前代码尚未形成完整的：

- 独立部署的 Intent 服务；当前已是单体内明确逻辑边界，但尚未作为跨产品服务拆分。
- 可跨业务线复用的编排 Runtime（目前 `research-harness.ts` 是研究产品专用 Runtime）。
- 任意代码 Skill 沙箱、加密签名信任链、Skill 市场和团队发布流。
- 生产 embedding/pgvector、完整本体与 Subjective World Model 训练评估闭环。
- 对外 MCP server、scoped API key，以及经第三条业务线和外部调用验证的 Universal Agent 契约。

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
- [x] 增加 workspace 级 Skill 启停、不可变 Run Skill Binding、声明式 HTTP JSON 与 MCP Streamable HTTP 受控执行器；仍不执行任意上传代码。
- [x] 增加受限 `atypica.skill/v1` / `SKILL.md` 包导入导出、版本化 capability grants、签名声明元数据、管理员审批/撤销与按需 executor health probe；包只保存声明和文档，不接受脚本、二进制或任意代码执行。
- [x] 增加 `hybrid_v1`、可替换 embedding 契约、PostgreSQL FTS/GIN 和离线检索评估；默认 `hash-ngram-128@v1` 是确定性基线，不冒充生产语义模型。
- [x] 接入生产 embedding provider 的离线候选评估与升级门槛；默认检索仍为 `hash-ngram-128@v1`，仅候选胜出后才进入 pgvector/HNSW 索引试验。
- [ ] 在通过门槛的候选模型上引入 pgvector/HNSW，并以 shadow retrieval 验证后才切换默认策略。
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
- [x] Plan 确认生成不可变 `study_plan_versions` 快照和内容 hash；每个 Run 通过同 Study 复合外键锁定精确 Plan Version。
- [x] 增加批量研究跨 Run 并排回放，可比较 Plan/Workflow/Strategy/Reasoning/Prompt/Provider/Context/Skill、任务图、checkpoint、决策、artifact 和事件时间线。
- [x] Plan 前生成版本化 Intent Contract，保存目标、受众、预算、数据范围、合规、允许的 Context purpose、澄清答案、解析版本、Context Snapshot 和内容 hash。
- [x] 确认时原子生成 confirmed Intent、Plan Version、WorkflowDefinition 和 Run 绑定；Runtime 从锁定 WorkflowDefinition 的任务图物化任务，历史 Run 不做 Intent/Workflow 推测回填。

### P3：多产品线与世界模型

- [x] 增加独立 Market Insight workflow，以相同 Intent/Plan/Workflow/Run/Skill/Context 契约验证第二产品线复用；其默认任务图不包含 Persona、Panel 或合成访谈。
- 通过稳定 API/MCP 暴露 research、market insight、product research workflow。
- 只有在具备合法、可追溯的研究样本和离线评估集后，才实现 Subjective World Model 的训练/蒸馏/评估；它不是简单增加一个 embedding 表。

## 是否需要现在加 Skills / Context

边界和数据契约已经落地，仍不需要伪造完整能力。

- Skills：manifest/version/schema/启停/Run Binding/远程执行审计、受限 `.skill` / `SKILL.md` 导入导出、capability grant 审批、撤销、健康审计已完成。签名目前只是如实保存为“已声明、未验证”的元数据；加密信任链、任意代码沙箱和发布市场仍后置。
- Context：资产版本、chunk、受控关系、来源/hash、同意/PII/保留期、审核队列、混合检索和评估已完成；Core/Working/Team Memory 复用同一 Context Asset 底座，通过用途、主体、有效期和不可变 policy version 在排序前执行门禁。Reasoning 的动态刷新只允许在 Context 不足、证据冲突或策略时效到期时触发，并绑定决策、Run、下一任务和完整检索快照。研究报告、Persona 和 Memory 晋升结果只能进入待审核候选，不会未经批准进入 Runtime。生产 embedding 必须先通过现有评估门槛。
- Persona：Claim/Evidence 精确关联、证据强度、有效期和保留/退役审计已完成。Context asset 批准与 Persona 可复用保留是两道独立门禁；新生成 Persona 默认 pending，只有 retained 且未过期者能进入 Runtime。
- 多 Agent：DAG wave、限流、租约、实验分组已完成；Research 与 Market Insight 已复用同一持久化 Runtime 契约，但仍不宣称全部业务线已经通用化。

## P1 已实现接口

- `GET /api/skills`：列出可执行内建 Skill 与工作区 Skill manifest。
- `POST /api/skills`：创建默认禁用的工作区 Skill manifest v1，可配置 HTTP JSON 或 MCP executor。
- `POST /api/skills/:publicId/versions`：发布新的 Skill 契约版本。
- `PATCH /api/skills/settings`：启用或禁用内置/工作区 Skill；workspace Skill 启用时固定当前版本。
- `POST /api/skills/:publicId/execute`：执行已启用的工作区远程 Skill，并持久化输入输出 hash、状态和错误。
- `POST /api/skills/packages/import`：导入严格的 `atypica.skill/v1` JSON 包，包含 manifest 和 `SKILL.md` 文本；未知字段、脚本载荷与超限内容被拒绝，导入后为 `submitted`。
- `POST /api/skills/:publicId/approval`：管理员以精确 capability grant 审批包；grant 为不可变版本记录，scope 与 Run Binding 一起锁定。
- `GET /api/skills/:publicId/package`：仅导出已审批的声明式 `.skill` 包。
- `POST /api/skills/:publicId/health`、`POST /api/skills/:publicId/revoke`：管理员触发 allowlist 约束下的 HTTP/MCP 健康探测，或撤销 Skill 阻断未来执行；既有 Run Binding 仍可回放。
- `/skills`：工作区 Skill Gateway，展示内置/远程 Executor、版本、hash、包生命周期、权限、签名声明和健康状态，并可注册或导入受控 Skill。
- `GET /api/context`：列出当前用户可见的 Context assets。
- `POST /api/context`：导入带 provenance、治理标签和来源 hash 的资产，创建首版本与确定性 chunks；工作台导入默认进入待审核状态。
- `PATCH /api/context/:publicId`：管理员批准或拒绝候选；只有批准后的 active asset 可进入检索。
- `POST /api/context/:publicId/versions`：发布不可变新版本并切换 current version，同时重新进入待审核状态。
- `POST /api/context/:publicId/edges`：在受控关系集合内建立资产来源/支持/冲突/提及/替代/相关关系。
- `POST /api/context/search`：执行带持久化 retrieval/items 的可审计检索。
- `/context`：工作区资产导入、治理筛选、审核、关系、reindex 和 tombstone 控制台。
- `GET /api/context/memory/policies`：返回 Core/Working/Team 当前 active policy 及版本、用途、保留、衰减和晋升门槛。
- `PATCH /api/context/memory/policies/:publicId`：管理员发布不可变新版 policy，旧版保留为 superseded。
- `GET|POST|PATCH /api/context/:publicId/memory`：按需读取 Memory 治理详情，提交/审核证据化行为观察，并将 Working Memory 晋升为待审核 Core/Team 候选。
- `GET /api/context/evaluation-sources`：仅向管理员列出工作区范围内已批准、已确认同意、已脱敏且未过期的真人研究样本当前 chunk。
- `GET|POST /api/context/evaluations`：列出检索评估集或保存 `human_relevance_v1` 人工标签；每个 case 固定标注人、时间、判断说明以及 chunk/asset/version/content hash 快照。
- `POST /api/context/evaluations/:publicId/run`：运行 baseline 或生产 embedding 候选评估；不足 20 条人工 case 时候选不能进入 shadow index 试验。
- `GET /api/personas/:publicId/evidence`：返回 Persona 的 Evidence、Claim、grounding 统计、保留状态和治理事件。
- `GET|POST /api/context/agent-evals`：列出或创建版本化 Agent Eval suite；只允许授权的不可变 Context version、已发布 Report version 和 retained Persona 作为 source。
- `POST /api/context/agent-evals/:publicId/run`：运行确定性可信度判定；`POST /api/context/agent-evals/:publicId/labels`：另行保存人工标签，不覆盖 judge result。
- `PATCH /api/personas/:publicId/evidence`：管理员或创建者明确保留/退役 Persona，并设置有效期与复核备注。
- `/persona`：Persona Library 展示证据状态、置信度、Claim/Evidence 数量和保留门禁，并提供证据与审计抽屉。

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

## 2026-08-14 Context Hybrid Retrieval 部署记录

- 远端 Supabase 已应用 `20260814050000_context_hybrid_retrieval.sql`；历史 Context asset/chunk/retrieval 均为 0，6 个研究和 21 个既有任务保持不变。
- `hybrid_v1` 以 PostgreSQL stored `tsvector` + GIN 为全文检索主路径，并以 `hash-ngram-128@v1` 确定性向量作为可复现基线；每次 retrieval 固定 strategy、embedding model/version 和 0.7/0.3 权重。
- Context 新增 tombstone 与 reindex generation：下架资产不进入新检索，历史 retrieval items 不被删除；重建索引记录独立 `context_reindex_runs` 审计。
- 新增版本化 evaluation set/case/relevance/run/result，保存 Precision@K、Recall@K 和 MRR；管理员 API 可创建评估集并运行对比。
- 隔离 PostgreSQL 15 完整迁移链 smoke 通过：目标 chunk 排名第一、reindex generation 1→2、Recall@K=1、MRR=1、tombstone 排除且历史 retrieval snapshot 仍可回放。
- 完整迁移链可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated context-hybrid`；已有测试库可直接运行 `CONTEXT_HYBRID_SMOKE_CONFIRM=1 pnpm smoke:context-hybrid`。两者都拒绝非 localhost / `127.0.0.1` 数据库。

## 2026-08-14 Production Embedding Evaluation Gate

- `POST /api/context/evaluations/:publicId/run` 默认运行确定性 `baseline`；管理员可显式提交 `{ "provider": "openai", "model": "text-embedding-3-small" }` 评测候选生产 embedding。
- `GET /api/context/evaluations` 返回当前工作区评估集及每个评估集最近 10 次 run，包含候选 model/version、状态、指标、gate 与失败原因。
- 候选与基线复用同一批 PostgreSQL FTS 候选、workspace/user 权限过滤、metadata filters 和 0.7/0.3 hybrid 权重。OpenAI 向量只驻留本次离线评测内存，不写入 `context_chunks`，不改变线上 `hybrid_v1`。
- 每次 run 保存候选 P@K / R@K / MRR、基线指标、差值、provider/model/version、请求数、输入数、维度、token usage、延迟及门槛结论。进入 pgvector/HNSW 索引试验的最低条件是至少 20 个 case、MRR 至少提升 `0.03` 且 P@K、R@K 不低于基线；通过评估不自动切换生产检索。
- 配置项：`OPENAI_EMBEDDING_PROVIDER_NAME`、`OPENAI_EMBEDDING_MODEL`（默认 `text-embedding-3-small`）、`OPENAI_EMBEDDING_VERSION`、`OPENAI_EMBEDDING_API_KEY`、`OPENAI_EMBEDDING_BASE_URL`、`CONTEXT_EMBEDDING_EVALUATION_BATCH_SIZE`（1-128，默认 64）和 `CONTEXT_EMBEDDING_EVALUATION_TIMEOUT_MS`（5-120 秒，默认 60 秒）。专用 key/base URL 未配置时才回退服务端 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。

## 2026-08-14 Plan Version 与跨 Run Replay 部署记录

- 远端 Supabase 已在单事务应用 `20260814060000_plan_versions_run_replay.sql`；迁移前后 7 个 Study、7 份当前 Plan、6 个 Run 和 21 个 Task 保持不变。
- 6 个历史 Run 均获得稳定 `run_*` public ID，并锁定到 6 个 `legacy_backfill` Plan Version；该标记只表示部署时可见的当前计划，不伪造已经丢失的历史修改过程。
- 新 Plan 确认会在同一事务创建不可变 `research-plan-v1` 快照、SHA-256 内容 hash 和确认人/时间；Runtime 按 `study_runs.plan_version_id` 读取，不再读取可能变化的当前 Plan。
- 新增 `GET /api/studies/[publicId]/runs/comparison` 和 `/study/[publicId]/compare`；可选择任意两个 Run，并排检查版本、任务图、checkpoint、Context、Skill、决策、artifact 与事件时间线。
- 隔离 smoke 创建 Plan v1/v2 与两个 Run，验证十类差异、不可变触发器、同 Study 外键、跨 workspace 隔离；reasoning/evidence/source/task-recovery 四条旧 smoke 完整迁移链继续通过。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated plan-version-replay`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-14 Skill 执行控制与 MCP Executor 部署记录

- 远端 Supabase 已在单事务应用 `20260814070000_skill_execution_control.sql`；迁移前后 7 个 Study、7 个 Run 和 11 条 Invocation 保持不变。
- 历史 Invocation 没有旧版 `skill_slug/version`，因此没有伪造 Run Binding；新批量 Run 在首次物化任务前锁定精确内置 Skill 版本、启用状态、executor 类型和内容 hash。
- `workspace_skill_settings` 管理工作区启停；`study_run_skill_bindings` 禁止直接更新/删除但允许父 workspace/run 级联清理；`skill_executions` 和 `skill_control_events` 保存远程执行与控制审计。
- 工作区 Skill 支持 `declarative_http` JSON POST 与标准 MCP Streamable HTTP client；两者均要求服务端 origin allowlist，密钥只引用 `SKILL_SECRET_*` 环境变量，并限制超时、响应大小、重定向和输入输出 JSON Schema。
- 内置研究 Skill 继续调用现有受控 TypeScript 实现，不开放任意代码上传；实时访谈 Skill 的禁用只阻止新会话，已开始会话继续使用启动时锁定的版本。
- 隔离 PostgreSQL 15 完整迁移链 smoke 验证 HTTP/MCP 各一次成功执行、schema 失败审计、4 条控制事件、禁用状态 Run Binding、不可变约束和跨 workspace 隔离；Plan Replay、Reasoning Runtime 与 Task Recovery 回归继续通过。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated skill-executor`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-15 Context Asset Flywheel 验收记录

- 远端 Supabase 已在单事务应用 `20260815010000_context_asset_flywheel.sql`；部署前 Context asset/version 均为 0，部署后既有 7 个 Study、5 份 Report 和 7 个 Run 保持不变。
- 新增 provenance 与治理契约：ingestion method、来源名称/MIME/URI/hash、human/synthetic/mixed、consent、PII、retention、origin 和 metadata；版本与当前资产均保存 SHA-256 内容 hash。
- 新增 pending/approved/rejected 审核生命周期和 `context_asset_events` 审计；待审核、拒绝和 tombstone 资产不会进入 Runtime 检索，发布新版本会强制回到待审核。
- 研究完成后自动提议一份 `research_sample` 报告资产和本 Run 新生成的 synthetic Persona，并建立 `derived_from` 关系；origin 唯一约束和应用层检查保证重试幂等。复用的既有 Persona 不重复沉淀。
- `/context` 工作台支持 TXT/Markdown/CSV/JSON 或手工导入、来源/治理标签、审核、筛选、关系、reindex 与 tombstone；导航已接入主工作区。
- 浏览器端实际走通“导入 pending → 管理员批准 → active/可检索”；顶部资产统计与同一客户端资产状态同步更新。1280 桌面和 390×844 移动端均无横向溢出、框架错误覆盖层或 console error/warn，QA 资产已在验证后清理。
- 隔离 PostgreSQL 15 完整迁移链 smoke 已通过：pending 排除、approve 后召回、新版本重新待审、reject 排除、provenance/hash、1 条人工关系、5 条资产事件、3 个自动候选和 2 条 Persona→Report 关系均已验证；同一批产物再次提议新增数为 0。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated context-asset-flywheel`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-15 Evidence-grounded Persona 部署与验收记录

- 远端 Supabase 已在单事务应用 `20260815020000_evidence_grounded_personas.sql`；迁移前后 7 个 Study、7 个 Run、5 份 Report 和 27 个 Persona 保持不变。
- 27 个历史 Persona 统一保留为 `retained + ungrounded`，不伪造已丢失的 Claim/Evidence 链接；部署时 Evidence Source/Item/Claim 均为 0，因此没有历史精确匹配候选。
- 自动 grounding 只接受同 Study/Run 中 `evidence_items.locator.personaPublicId/personaName` 的精确匹配；Source 级标签、语义相似和 Report 内所有 Claim 都不会扩大关联范围。
- 新生成 Persona 默认 `pending`；只有 `retained` 且 `valid_until` 未过期的 Persona 可被 Runtime 检索或新访谈项目选用。编辑 Persona 会删除旧链接、重置为 `ungrounded` 并记录失效事件。
- `/persona` 浏览器验收已走通证据抽屉、退役和恢复保留；Persona 退役后立即从新访谈选择器消失，恢复后重新可选。1280 桌面和 390×844 移动端无横向溢出、框架错误或 console error/warn；QA 治理事件和复核字段已清理。
- 隔离 PostgreSQL 15 完整迁移链 smoke 已验证：2 条精确 Evidence 链接、无关证据排除、pending/retained/expired/retired 复用门禁、编辑失效、重新 grounding 和 5 条幂等治理事件；Context Asset Flywheel 与 Evidence Graph 回归继续通过。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated persona-evidence`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-15 Memory 与 Context Policy 部署与验收记录

- 远端 Supabase 已在单事务应用 `20260815030000_memory_context_policy.sql`；部署前后 7 个 Study、27 个 Persona 和 0 个 Context asset 保持不变，没有伪造历史 Memory 或行为观察回填。
- Replay 回归发现旧版 Plan Version 不可变触发器会误拦 workspace/study 级联删除；远端已在独立单事务应用 `20260815031000_plan_version_cascade_cleanup.sql`。直接 update/delete 仍被拒绝，只允许外键触发器深度内的父级级联清理；7 个既有 Plan Version 保持不变。
- 当前唯一工作区创建 Core/Working/Team 三个 active policy v1；`context_memory_bindings`、`context_behavior_observations`、`context_memory_events` 部署后均为 0。
- Memory 不使用第二套存储；`core_memory`、`working_memory`、`team_memory` 都是受治理的 Context Asset，并通过 binding 锁定主体、置信度、有效期和 policy。
- 检索支持 `general`、`intent_planning`、`research_execution`、`realtime_interview`、`report_generation`、`skill_execution` 六种用途；SQL 在 FTS/混合排序前完成 purpose、主体和时效门禁，Retrieval Snapshot 保存 policy version 和允许/拒绝摘要。
- Working Memory 晋升只计算已审核且未过期的行为观察；达到门槛后也只创建 pending Core/Team 候选和 `derived_from` 边，必须再经 Context asset 审核才能进入检索。
- `/context` 已增加 Memory 筛选/指标、三类 policy 版本控制、观察审核、晋升与治理事件详情；详情按需加载，首屏 assets/policies 并行读取。
- 隔离 PostgreSQL 15 完整迁移链 smoke 已验证默认 policy、purpose 拒绝、跨用户隔离、过期排除、2 条观察审核、双重晋升门禁、policy v2、snapshot 持久化与事件幂等；Context Hybrid、Asset Flywheel 和 Persona Evidence 回归继续通过。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated context-memory-policy`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-15 Intent Contract 与 Workflow Definition 实现记录

- 远端 Supabase 已在单事务应用 `20260815040000_intent_workflow_contracts.sql`；部署前后 7 个 Study、7 个 Plan Version 和 7 个 Run 保持不变。新增 Intent/Workflow 表均为 0，历史 Plan/Run 契约绑定保持 `null`，两条不可变触发器已启用。
- 新增 `20260815040000_intent_workflow_contracts.sql`：`study_intent_versions` 与 `workflow_definitions` 内容不可更新/直接删除，Plan Version 和 Run 通过同 Study 复合外键锁定精确 Intent/Workflow；历史 Plan/Run 字段保持 `null`，不推测回填。
- 新 Study 创建与澄清都会先运行 `purpose=intent_planning` 的受治理 Context 检索，再生成 Intent/Plan；Snapshot 保存 Memory policy 允许/拒绝摘要，生成型 Persona Context 还必须对应 retained 且未过期的 Persona。Intent 保存引用版本、目标、受众、预算、数据范围、合规、方法、排除项、假设、开放问题和解析 provenance。
- 用户确认会在同一事务生成 confirmed Intent、不可变 Plan Version、`workflow-definition-v1` 与首个 Run。Workflow 保存任务图、精确 Skill 要求、Runtime 限制、Context policy、输出契约、证据 gate、compiler version 和内容 hash。
- Runtime 优先从 Run 锁定的 WorkflowDefinition 物化任务；旧 Run 才回退现有 research DAG 生成器。Study 规划界面显示 Intent/Planning Context provenance，跨 Run Replay 分开展示 Intent Planning 与 research execution Context。
- 隔离 PostgreSQL 完整迁移链 smoke 已验证 draft → clarified draft → confirmed supersession、purpose denial、Context Snapshot、不可变 hash、四重 Run 绑定、重复确认幂等、跨 workspace 隔离和 legacy null semantics；Memory Policy、Hybrid Retrieval、Plan Replay 与 Reasoning Runtime 回归继续通过。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated intent-workflow-contract`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-15 Market Insight 第二产品线部署与验收记录

- 远端 Supabase 已在单事务应用 `20260815050000_market_insight_workflow.sql`；部署前后 7 个 Study、7 个 Plan Version 和 7 个 Run 保持不变，历史 Study 全部明确保留为 `research`，没有推测回填 Market Insight Intent、Workflow 或 Run。
- Study 创建入口新增 `research | market_insight` 产品线选择；产品线写入 Study、Intent 和不可变 Plan Version，并进入内容 hash、详情页和跨 Run Replay。
- Research 继续编译为 `batch_research@research-dag-v3-dynamic`；Market Insight 编译为 `market_insight@market-insight-dag-v1`，输出契约锁定为 market landscape、opportunity map、competitive signals、evidence 和 report。
- Market Insight 默认任务图只复用受控 `designStudy`、`deepResearch` / `scoutSocialTrends` 和 `generateReport` Skill，不创建 Persona、Panel、合成访谈或讨论任务。Runtime 继续从 Run 锁定的 `workflow_definitions.task_graph` 执行，策略实验按 Run 的 workflow type 分配。
- 隔离完整迁移链 smoke 同时创建 Research 与 Market Insight，验证 Intent/Plan/Workflow/Run 四重绑定、Context purpose、任务图边界、输出契约、不可变 hash、重复确认幂等、跨 workspace 隔离、回放身份和 Market Insight 策略分配；Intent Workflow、Plan Replay、Reasoning、Skill Executor 与 Memory Policy 回归继续通过。
- `/newstudy` 桌面和 390×844 移动端已验证产品线切换、差异化文案与场景模板；无横向溢出、框架错误覆盖层或 console error/warn。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated market-insight-workflow`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-15 受治理 `.skill` 包部署与验收记录

- 远端 Supabase 已在单事务应用 `20260815060000_skill_package_governance.sql`。依赖的 `study_run_skill_bindings` 已存在；部署前新治理表不存在，且没有活跃工作区远程 Skill，因此没有对历史研究、Run 或执行记录进行伪造回填。
- `atypica.skill/v1` 是严格 JSON 包，只包含显式 manifest、`SKILL.md` 文本和可选签名声明。未知字段会被拒绝，包不允许脚本、二进制、路径、任意文件或任意代码执行。
- 导入包先进入 `submitted`；管理员必须以版本精确的 `network`、`context_read`、`files_read`、`provider_invoke` grant 审批。HTTP/MCP 执行前再次检查有效 grant，HTTP/MCP 隐含的网络/Provider 权限不会由 Skill 自行扩大。
- secret 仍只保存 `SKILL_SECRET_*` 环境变量引用，不持久化 secret value。签名当前显式标记为 `declared_unverified`，没有把元数据冒充为加密信任；撤销会禁用并阻止未来执行，但不改写既有不可变 Run Binding/权限快照。
- 管理员可按需探测受 allowlist、HTTPS、超时、响应大小和重定向约束的 executor；结果写入 `skill_executor_health_checks` 和控制审计，不启动后台探测守护进程。
- 隔离 PostgreSQL 15 完整迁移链 smoke 已验证非法载荷拒绝、submitted 阻断、最小权限审批、secret reference-only、HTTP health、稳定包哈希导出、不可变 Run grant snapshot、撤销阻断和跨 workspace 隔离；既有 Skill Executor、Intent Workflow、Reasoning Runtime 与 Market Insight 回归通过。
- `/skills` 在桌面和 390×844 移动端均验证了 `.skill` 导入控件与受控空状态；迁移部署后的新页面加载没有 framework overlay 或新的 console error/warn。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated skill-package-governance`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-15 Agent Eval 与动态 Context 部署记录

- 远端 Supabase 已在单事务应用 `20260815070000_agent_eval_dynamic_context.sql`；部署前后的 8 个 Study、12 个 Run 和 4 个 Context retrieval 保持不变。新 Eval suite 与动态检索 binding 均为 0，没有伪造黄金集、人工标签或历史刷新记录。
- 移除“每个 Run 仅一份 Context retrieval”的旧索引，但仍保留初始 Run 快照的幂等复用。只有 `insufficient`、`conflicted`、`stale` 三种确定性触发能追加刷新；每次刷新绑定 Reasoning Decision、Run、下一任务、检索 query/filter/policy 和不可变引用项，重放同一 Decision 复用同一快照。
- `agent_eval_suites` 以 `suite_key + version` 保存契约；case 只允许 `fabricated_citation` 和 `persona_convergence` 两类信任维度。Context source 必须是当前 active/approved asset 的不可变 version，Report 必须已发布，Persona 必须 retained 且未过期。
- Judge 使用 `deterministic-trust-v1` 检查未声明引用、缺失必需引用和不足的独立 Persona source；它和人工 `pass/fail/needs_review` 标签分别持久化，不能把自动判断伪装为人工结论。
- `/context` 显示 suite 状态、信任维度、case 数、最近一次结果和失败数；研究详情的 Reasoning trace 显示 Context 刷新触发、快照、目标任务和引用数。
- 隔离 PostgreSQL 15 完整迁移链 smoke 已验证未授权 source 拒绝、2 个可信度失败、独立人工标签、动态 Context binding 和同一 Decision 重放复用；不引入 pgvector/HNSW、LangGraph 或未授权数据摄取。
- 可重复命令：`LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated agent-eval-dynamic-context`，仅允许 localhost / `127.0.0.1` 数据库。

## 2026-08-16 人工检索评估闭环部署记录

- 远端开发数据库已应用 `20260816080000_human_relevance_evaluation.sql`，并只读确认 6 个新增字段存在；迁移没有创建、修改或伪造任何业务样本与人工标签。
- 新建 relevance case 只接受 workspace scope、active/approved、`research_sample`、`human`、`confirmed`、PII 为 `none/redacted` 且未过期的当前 Context chunk。普通文档、合成/混合样本、未同意、未脱敏、待审核、历史版本和过期内容都不能进入黄金集。
- 每个新 case 保存 `human_annotated`、标注人、标注时间、判断说明和不可变来源快照；既有评估数据保持 `legacy_v0 / legacy_unverified`，不会被回填成人工黄金标签。
- `/context` 已增加检索评估工作台，可批量整理标签、查看 20-case 门槛、运行确定性 baseline，并只在达到门槛后开放生产 embedding candidate 评估。初始部署时数据库为 `0` 个合规样本 chunk、`0` 条人工 relevance case；pgvector/HNSW 保持禁用。
- `pnpm lint` 与 `pnpm build` 已通过。隔离数据库 smoke 因当前环境没有 localhost PostgreSQL 而未运行；其 localhost 防护没有被绕过。Browser 对 localhost 的 URL 安全策略阻止了自动页面 QA，未改用其他浏览器规避。

## 2026-08-16 合规研究样本导入记录

- 已通过 `scripts/import-zenodo-llm-interviews.ts` 导入 Zenodo `10.5281/zenodo.17484327` 的 20 份英文访谈转录。记录为开放访问、CC BY 4.0，发布说明明确该数据已匿名化且参与者明确同意公开匿名数据。
- 导入器在写入前核验元数据的开放访问/许可/匿名化/明确同意声明、完整 `P1` 至 `P20` 文件清单、每个发布方 MD5、字节大小以及邮箱/电话/URL 基础 PII 模式；每份资产保留精确 Zenodo 文件 URL、文件名和内容 hash。重复执行按 `source_uri` 跳过既有资产。
- 工作区目前有 20 个 `approved + active` 的真人研究样本资产、273 个可检索 chunk、0 条人工 relevance case。样本已经具备人工标注的来源基础，但任何检索相关性判断仍必须由授权研究人员在 `/context` 工作台中逐条确认。

## 验收标准

- 任意一次运行可以重放：workflow、skill version、prompt version、context version、provider model 均可定位。
- 任意报告结论都能追溯到 artifact、访谈 session 或 context source。
- 同一 workspace 的 context/skill 不能跨租户泄露。
- 实时与批量 workflow 共用 Runtime，但可以独立设置超时、并发和预算。
- 策略实验可按实验组比较完成率、成本、响应质量和人工复核结果。
