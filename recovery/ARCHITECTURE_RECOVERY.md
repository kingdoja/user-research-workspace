# atypica.AI / GEA 架构恢复审计

日期：2026-08-13

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
- [ ] 实时在线访谈 Agent 尚未迁入通用 Runtime；当前实际执行的 workflow 是 `batch_research`。
- [ ] 增加人工质量评分、访谈完成率、逐题覆盖等领域指标和 replay 对比 UI。

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

Runtime 默认值：每 run 2 个并发 task、每 workspace 2 个活跃研究 run、每 provider 4 个活跃研究 run、每 workspace/provider 每分钟 30 个 Provider 任务。均可通过 `RESEARCH_*` 环境变量调整并在代码中限制上下界。

## 验收标准

- 任意一次运行可以重放：workflow、skill version、prompt version、context version、provider model 均可定位。
- 任意报告结论都能追溯到 artifact、访谈 session 或 context source。
- 同一 workspace 的 context/skill 不能跨租户泄露。
- 实时与批量 workflow 共用 Runtime，但可以独立设置超时、并发和预算。
- 策略实验可按实验组比较完成率、成本、响应质量和人工复核结果。
