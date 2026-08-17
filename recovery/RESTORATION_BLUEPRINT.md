# atypica.AI / GEA 完整还原方案

日期：2026-08-14
定位：基于公开产品、公开工程文章、公开研究回放、旧站归档和当前仓库的 clean-room 恢复设计。  
目标：还原 atypica.AI 的核心产品体验，并用可审计、可恢复、可演进的工程实现替代无法确认的原私有实现。

## 1. 执行结论

建议把还原目标拆成两层：

1. **Atypica 产品层**：Plan Mode、Scout、Persona/Panel、Interview/Discussion、报告、研究回放、分享和追问。
2. **GEA 平台内核**：Intent、Reasoning Runtime、Execute Runtime、Skills、Context System、Provider Gateway。

当前仓库已经具备产品层的大部分骨架，以及 GEA 内核的第一版持久化契约。下一阶段不应重写成 Python 微服务，也不应立即引入 LangGraph、Milvus 或 RabbitMQ。最稳妥的路线是继续采用 **Next.js + PostgreSQL + 独立 Worker**，先完成可信证据链、动态编排和真实数据接入；只有吞吐量或组织边界真正要求时，再拆服务。

必须纠正的两个概念：

- 官方文章中的 GEA 是 **Generative Enterprise Architecture**，不是 Generative Enterprise Agent。
- 官方描述更接近“四个核心部分”，不是严格上下堆叠的四层。Context System 位于侧面并持续服务 Intent、Reasoning 和 Execute。

恢复的核心验收标准不是“能生成一篇报告”，而是：

> 任意结论都能区分事实、观察、合成模拟和模型推断；任意运行都能定位计划、工具、Skill、Context、模型、输入、输出、失败和重试。

## 2. 证据分级

### A 级：产品页面或研究回放直接可见

- 首页公开流程：AI Persona 生成 -> AI 主导访谈 -> 行为分析 -> 即时洞察。
- Plan Mode 将自然语言需求转换为研究类型、方法论框架、方法组合和 Persona 池，用户确认后锁定执行计划。
- 公开列出的研究类型：User Research、Fast Insight、Product R&D、Panel Only。
- 公开列出的方法：Interview Chat、Discussion Chat、Scout Agent、Fast Insight。
- Scout 的公开工作方式：观察、推理、验证；定位为定性田野观察，不提供统计显著性。
- Scout 公开支持小红书、抖音、TikTok、X/Twitter、Instagram 的公开内容。
- 研究回放公开展示过 `reasoningThinking`、`interviewChat`、`saveAnalystStudySummary`、`generateReport` 等工具事件。
- 单个 Persona 访谈失败后会被重试，失败信息曾暴露 LiteLLM、AWS Bedrock 和 `claude-3-7-sonnet`。
- 报告是独立 artifact，拥有 raw、share 和 token；Study 有独立 share/replay 页面。
- 报告生成后可以继续追问，并再次调用报告工具。
- 团队 API Key、个人 API Key、MCP、嵌入式登录和团队成员接口曾作为公开产品能力出现。

### B 级：官方工程文章明确描述

- GEA 的四个核心部分：Intent Layer、Context System、Reasoning Agent、Execute Agent + Skills。
- Reasoning Agent 负责规划、准备 Context、调整方向和决定停止，不直接执行业务任务。
- Execute Agent 是通用执行器，按需加载 Skill。
- 官方列出的研究 Skills：`scoutTaskChat`、`interviewChat`、`buildPersona`、`reportGen`。
- Context 分 Build Time 长期资产与 Runtime 会话上下文，并强调过滤、关联和持续整理。
- Skills 采用渐进披露，避免一次性把全部能力塞进模型上下文。
- GEA 明确不适合固定 SOP、强约束审批或实时操作类任务。
- Universal Agent 工程文章明确展示过 Next.js 15、Vercel AI SDK、`bash-tool`、Claude 4.5 Sonnet、S3 Skill 存储和持久化 workspace；这只能证明 Universal Agent 示例实现，不能证明所有研究服务都使用相同栈。

### C 级：当前仓库和旧站归档可以确认

- 原公开部署使用 Next.js，源码映射不可用，无法恢复原 TypeScript 和服务端源码。
- 当前仓库已实现账户、workspace、study、plan confirmation、Persona、Panel、AI/真人 Interview、报告、分享、追问和 SSE 事件。
- 当前 research harness 已有 DAG 依赖、并发 wave、checkpoint、artifact、tool invocation、租约队列、取消、重试、限流和实验分组基础。
- 当前 Skill/Context 迁移已增加版本化 manifest、asset/version/chunk/edge/retrieval 和审计契约。

### D 级：目前只能作为重建选项，不能声称是原实现

- FastAPI、RabbitMQ、Redis Stream、Milvus、Qdrant、MinIO。
- LangGraph 作为原平台运行时。
- Firecrawl 或“搜索 -> 自研网页精读 -> 舆情 API”的固定三段实现。
- 原平台的具体模型路由算法、Prompt、向量模型、训练数据和 Subjective World Model 算法。
- 小红书、抖音数据到底来自官方合作、第三方供应商、MCP、浏览器自动化还是内部采集系统。

## 3. 对粘贴材料的甄别

| 粘贴材料说法 | 判断 | 还原时的处理 |
| --- | --- | --- |
| GEA 是四层企业智能体底座 | 部分正确 | 改为四个核心部分；Context 横向服务其他部分 |
| GEA = Generative Enterprise Agent | 不正确 | 使用官方名称 Generative Enterprise Architecture |
| Intent 优先、双 Agent、动态 Skills | 有官方依据 | 作为目标架构核心 |
| Scout 为观察、合成、验证 | 基本正确 | 官方用词为观察、推理、验证 |
| Scout 必然使用 Firecrawl 范式 | 无证据 | 仅作为可替换 Connector 实现方案 |
| FastAPI + RabbitMQ + Milvus | 无证据 | MVP 不采用，继续使用现有 TypeScript/PostgreSQL |
| LangGraph 是推荐临时 Harness | 属于外部建议 | 当前自研 harness 已更贴合仓库，不引入新依赖 |
| 所有洞察强制原始 URL 溯源 | 方向正确，但原公开报告未做到 | 在重建版中升级为强约束 |
| 公开报告的比例和样本量可直接复刻 | 高风险 | 必须有来源和计算过程，否则禁止展示为事实 |

## 4. 原产品行为模型

### 4.1 用户主流程

```text
研究 Brief
  -> Plan Mode 澄清和生成计划
  -> 用户确认并锁定 Plan Version
  -> Scout / Deep Research 获取外部观察
  -> 检索或生成 Persona
  -> 物化 Panel
  -> Interview / Discussion / Audience Call
  -> Reasoning 评估证据缺口
       -> 证据不足：补充观察或访谈
       -> 证据冲突：启动验证分支
       -> 已经充分：停止探索
  -> 结构化报告 Artifact
  -> Share / Replay / Follow-up / Regenerate
  -> 将可复用资产沉淀到 Context
```

### 4.2 Study 状态机

```text
draft
  -> clarifying
  -> planned
  -> awaiting_confirmation
  -> queued
  -> running
       -> waiting_input
       -> retrying
       -> cancelling
  -> completed
  -> failed
  -> cancelled
```

约束：

- Plan 确认后生成不可变 `plan_version`。
- 修改范围不是原地覆盖，而是创建新 plan version 或新 run。
- Study 是业务容器，Run 是一次执行，Task 是 DAG 节点，Invocation 是一次工具尝试，Artifact 是持久产物。
- Follow-up 属于同一 Study 的新 interaction，可读取已完成 artifact，但不得偷偷改写旧报告。

### 4.3 Reasoning 循环

Reasoning 不应完全依赖一个自由发挥的 Agent。建议采用“模型判断 + 确定性护栏”：

1. 读取 Intent、当前 checkpoint、预算、已完成 artifact 和证据缺口。
2. 产生候选动作：继续 Scout、创建 Persona、访谈、讨论、验证、生成报告、停止。
3. 用规则过滤非法动作：依赖未满足、预算超限、权限不足、数据源不可用、重复调用。
4. 执行选定 Skill，持久化 invocation 和 artifact。
5. 计算 coverage、conflict、novelty、cost、failure 等指标。
6. 满足停止条件后生成报告，否则进入下一轮。

推荐停止条件：

- 所有必需报告章节都有至少一个合格 Claim。
- 高优先级 Claim 至少有两个独立 Evidence Item，或明确标记为单源观察。
- 最近两轮新增证据的主题新颖度低于阈值。
- 没有未解决的高风险冲突。
- 达到 token、时间、调用次数或费用预算时强制停止，并在报告中记录限制。

## 5. 目标架构

```text
Next.js Web / API / Public Share / MCP
                    |
             Intent Service
                    |
         Orchestration Runtime + Queue
          /            |             \
 Skill Gateway   Context System   Provider Gateway
      |                |               |
 Built-in Skills   PostgreSQL       LLM / Search
 Workspace Skills Object Storage   Social Connectors
      |                |
      +---------- Evidence Graph --------+
                    |
            Reports / Replay / Audit
```

### 5.1 部署形态

MVP 建议：

- 一个 Next.js Web/API 服务。
- 一个或多个同代码库 Worker 进程。
- 一个 PostgreSQL/Supabase 数据库。
- 一个 S3 兼容对象存储，用于原始页面、附件、报告快照和 Skill 包。
- 搜索、LLM、邮件、社媒数据全部通过 Provider/Connector 接口接入。

暂不增加 Redis。队列、租约、限流窗口和 checkpoint 已可由 PostgreSQL 承担。出现以下信号再拆分：

- 单库队列锁竞争成为明确瓶颈。
- Worker 每分钟需要处理数千个短任务。
- 实时事件扇出超过数据库通知或 SSE 能力。
- 不同数据源连接器需要独立安全域或部署区域。

### 5.2 Intent Service

输入不是直接 Prompt，而是版本化 `ResearchIntent`：

```json
{
  "objective": "验证年轻白领对健康型气泡水定位的接受度",
  "audience": {
    "description": "25-35 岁一线城市白领",
    "filters": { "ageMin": 25, "ageMax": 35, "cities": ["一线城市"] }
  },
  "studyType": "user_research",
  "frameworks": ["STP"],
  "methods": ["scout", "discussion", "interview"],
  "deliverables": ["report"],
  "constraints": {
    "maxTokens": 150000,
    "maxDurationMinutes": 240,
    "maxExternalSources": 80,
    "humanConfirmationRequired": true
  },
  "assumptions": [],
  "openQuestions": []
}
```

必须保存：schema version、生成模型、prompt version、生成时间、用户修改记录和确认人。

### 5.3 Orchestration Runtime

当前 `research-harness.ts` 可以继续演进，不需要替换：

- DAG 任务和依赖就绪调度。
- task wave 并发。
- checkpoint 和幂等 invocation。
- job lease、超时、重试、取消。
- workspace/provider 并发与速率限制。
- strategy experiment 分组与指标记录。

下一步需要补的核心能力：

- 显式 `ReasoningDecision` 记录：候选动作、选择原因、输入 artifact、预算快照。
- 动态追加任务，而不只是在确认计划时一次性生成固定 DAG。
- `waiting_input` 恢复协议。
- 每类错误的 retry policy：瞬时、输入错误、余额不足、权限、永久 Provider 错误。
- Run replay：可以从任一 checkpoint 用固定版本重新执行。

### 5.4 Skill Gateway

Skill 是版本化能力包，不等于任意代码上传。最小契约：

```ts
type SkillManifest = {
  id: string;
  version: string;
  description: string;
  capabilities: string[];
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  permissions: string[];
  timeoutSeconds: number;
  retryPolicy: "none" | "transient" | "bounded";
  executor: "builtin" | "remote_http" | "mcp" | "sandbox";
};
```

执行前必须完成：

- workspace 可见性和启停检查。
- 精确版本解析，不允许运行中漂移到 latest。
- 输入/输出 schema 校验。
- capability 和数据访问授权。
- secret 由平台注入，禁止写入 Skill 文件或模型上下文。
- invocation 审计、token/费用、超时和结果大小限制。

推荐内建 Skills：

- `designStudy`
- `deepResearch`
- `scoutSocialTrends`
- `searchPersonas`
- `buildPersona`
- `createPanel`
- `interviewChat`
- `discussionChat`
- `audienceCall`
- `reasoningThinking`
- `saveStudySummary`
- `generateReport`
- `publishArtifact`

Workspace Skill 当前可以绑定受控 `declarative_http`、MCP Streamable HTTP 或 `sandbox` executor；地址必须命中服务端 allowlist，secret 只允许引用 `SKILL_SECRET_*` 环境变量。`atypica.skill/v1` 继续只包含严格 manifest、`SKILL.md` 文本和可选的未验证签名声明；`atypica.skill/v2` 才允许 JavaScript/Python 源文件，并强制使用外部 `atypica.sandbox/v1` Runner。两类包导入后都必须由管理员授予版本精确的 capability，代码包还必须具备不可变 `code_execute` grant。Next.js 和 PostgreSQL 均不执行上传代码。

### 5.5 Context System

Context 应区分四类对象：

- Memory：用户或团队偏好、判断标准、长期关注点。
- Asset：报告、文件、网页、访谈、Persona、Panel、研究模板。
- Runtime Context：当前 run 的观察、摘要、推理结果和 checkpoint。
- Skill Knowledge：方法论、说明、模板和示例。

检索结果必须产生不可变 snapshot：

```json
{
  "retrievalId": "ret_xxx",
  "strategy": "hybrid_v1",
  "query": "Z 世代气泡水健康定位",
  "items": [
    {
      "assetVersionId": "cxv_xxx",
      "chunkId": "cxc_xxx",
      "score": 0.82,
      "reasons": ["semantic", "same_workspace", "recent"],
      "sourceUri": "https://example.com/source"
    }
  ]
}
```

当前 `lexical_metadata_v1` 足以作为 P1。下一阶段增加 embedding 时，必须保留 lexical、metadata 和权限过滤，并将 embedding model/version 写入 retrieval。

### 5.6 Provider Gateway

统一抽象四类 Provider：

- LLM Provider：OpenAI、Anthropic/Bedrock、DeepSeek 等。
- Search Provider：Tavily、Bing 或其他授权搜索源。
- Social Connector：合规第三方数据、官方 API、MCP 或受控浏览器采集。
- Artifact Provider：对象存储、HTML/PDF 渲染、音频生成。

每次调用记录：provider、model、endpoint class、request hash、prompt version、response id、usage、费用、latency、retry、错误类别和安全策略版本。

## 6. 可信证据模型

这是重建版相对原公开体验最需要升级的部分。

### 6.1 四层证据链

```text
Source
  -> Evidence Item
  -> Claim
  -> Report Node
```

- `Source`：网页、帖子、文件、真人访谈、合成访谈、内部数据集。
- `Evidence Item`：可引用的原文片段、访谈 turn、结构化记录或计算结果。
- `Claim`：系统形成的判断，带置信度、范围和证据集合。
- `Report Node`：报告中的段落、图表、指标或建议，引用一个或多个 Claim。

### 6.2 Evidence 类型

| 类型 | 可以支持什么 | 禁止表达 |
| --- | --- | --- |
| `public_source` | 公开事实、市场信息、原文观点 | 未采集到的统计总体结论 |
| `social_observation` | 定性语言、场景、假设 | 代表全体用户的百分比 |
| `human_interview` | 该受访者的观点、跨样本定性模式 | 超出样本范围的统计推断 |
| `synthetic_interview` | 假设探索、脚本压力测试、方向比较 | “20 位真人受访者认为” |
| `model_inference` | 综合解释和建议 | 冒充外部事实或用户原话 |
| `computed_metric` | 有明确输入和公式的数字 | 无计算过程的装饰性百分比 |

### 6.3 Claim 最小结构

```json
{
  "statement": "目标人群在送长辈场景更关注低糖和成分透明度",
  "kind": "qualitative_pattern",
  "scope": "本次合成 Panel 与公开来源",
  "confidence": "medium",
  "evidenceIds": ["ev_1", "ev_2", "ev_3"],
  "counterEvidenceIds": ["ev_4"],
  "generatedByInvocationId": "inv_xxx",
  "limitations": ["未进行真人抽样验证"]
}
```

### 6.4 报告规则

- 每个事实型段落至少引用一个 Evidence Item。
- 每个百分比必须绑定 `computed_metric`，保存分子、分母、公式和样本定义。
- 合成 Persona 的引语必须标记“合成访谈”，不能显示成真人原话。
- 模型生成的用户原话如果不对应真实 turn，禁止使用引号。
- 报告必须展示研究方法、样本构成、真实/合成比例、数据时间范围和局限。
- 分享页面只暴露允许公开的证据，私有源显示脱敏摘要或受限标识。

## 7. 数据模型

当前表可以继续使用；建议按下列逻辑补齐，而不是另起一套数据库。

### 7.1 已有或基本已有

- `users`, `workspaces`, `workspace_members`
- `studies`, `study_events`, `study_runs`, `study_tasks`
- `study_tool_invocations`, `study_run_checkpoints`, `study_artifacts`, `study_job_queue`
- `study_personas`, `study_panels`, `study_panel_members`
- `interview_projects`, `interview_runs`, `interview_sessions`, `interview_messages`
- `skill_manifests`, `skill_versions`, `skill_audit_events`
- `context_assets`, `context_asset_versions`, `context_chunks`, `context_edges`
- `context_retrievals`, `context_retrieval_items`
- runtime slot、rate window、strategy experiment/variant/assignment/metric 表

### 7.2 建议新增

#### `study_plan_versions`

- `study_id`, `version`, `intent_json`, `plan_json`
- `generated_by_model`, `prompt_version`
- `created_by`, `confirmed_by`, `confirmed_at`

#### `reasoning_decisions`

- `run_id`, `sequence`
- `input_checkpoint_id`
- `candidate_actions`, `selected_action`, `rationale`
- `budget_snapshot`, `policy_version`, `model`

#### `evidence_sources`

- `workspace_id`, `source_type`, `canonical_uri`
- `title`, `platform`, `author`, `published_at`, `collected_at`
- `content_hash`, `raw_object_key`, `visibility`, `license_metadata`

#### `evidence_items`

- `source_id`, `artifact_id`, `interview_message_id`
- `locator_json`：页码、段落、时间码、CSS selector 或 turn index
- `excerpt`, `normalized_content`, `language`
- `provenance_type`, `verification_status`

#### `claims`

- `study_id`, `run_id`, `statement`, `kind`, `scope`
- `confidence`, `status`, `limitations`
- `generated_by_invocation_id`

#### `claim_evidence`

- `claim_id`, `evidence_item_id`, `relation`
- `relation`：supports、contradicts、contextualizes

#### `report_versions` / `report_nodes`

- 报告版本不可变。
- Node 使用结构化 JSON 表示 section、paragraph、quote、metric、chart、table、recommendation。
- Node 到 Claim 单独关联，支持引用检查和局部重生成。

## 8. API 契约

### 8.1 Study

- `POST /api/studies`：创建 draft，生成 Intent/Plan v1。
- `POST /api/studies/:id/messages`：Plan Mode 澄清或修改计划。
- `POST /api/studies/:id/confirm`：确认指定 plan version 并创建 run。
- `POST /api/studies/:id/runs`：使用现有或新 plan 创建重跑。
- `POST /api/studies/:id/cancel`：请求取消当前 run。
- `GET /api/studies/:id/events`：SSE 增量事件。
- `POST /api/studies/:id/followups`：基于已完成 artifact 追问。

### 8.2 Runtime

- `GET /api/runs/:id`：状态、checkpoint、预算和任务图。
- `GET /api/runs/:id/replay`：按 sequence 返回 reasoning、invocation、artifact 事件。
- `POST /api/runs/:id/resume`：从 waiting_input 或可恢复失败继续。
- `POST /api/runs/:id/retry-task`：只重试允许的 task/invocation。

### 8.3 Evidence 和 Report

- `GET /api/artifacts/:id`
- `POST /api/artifacts/:id/publish`
- `GET /api/reports/:id/versions`
- `GET /api/reports/:id/citations`
- `GET /api/claims/:id/evidence`
- `POST /api/reports/:id/regenerate`：创建新版本，不覆盖旧版本。

### 8.4 Skill 和 Context

沿用当前 `/api/skills`、`/api/context` 和版本接口：

- [x] Skill enable/disable、不可变 Run Binding、远程执行审计和 MCP/HTTP executor。
- [x] 声明式 `.skill` / `SKILL.md` 导入导出、不可变 capability permission grants、签名声明、撤销与管理员按需 executor health probe。
- Context ingestion job、reindex、delete/tombstone、retention policy。
- Retrieval debug，仅对 workspace 管理员或开发模式开放。

## 9. 前端还原范围

### 9.1 第一优先级

- `/newstudy`：对话式 Plan Mode，显示可修改计划和预算。
- `/study/:id`：Agent workspace，左侧会话/事件，中间任务时间线，右侧 Artifact/Panel/Report。
- Persona Library 和 Panel Builder。
- Interview Project：AI 与真人 session、问题、邀请、结果对比。
- Report Reader：目录、结构化内容、逐条引用、下载、分享。
- Replay：按原顺序重放 reasoning、tool、result、retry、artifact。

### 9.2 第二优先级

- Universal Agent + My Skills。
- Team Memory / Core Memory 可视化。
- MCP 与 API Key 管理。
- Fast Insight / Podcast。
- Sage 专家系统。

### 9.3 明确免责声明

- Scout 是定性观察，不是社媒统计监听。
- AI Persona 是合成模拟，不代表真实总体。
- 没有真实样本时，不显示“人类相似度 85%”或任何准确率承诺。
- 报告默认显示“AI 生成并需人工复核”，同时区分事实证据和模型推断。

## 10. Scout 还原方案

不要把 Scout 与“裸爬虫”绑定。统一定义 Connector：

```ts
type SocialConnector = {
  search(query: SocialQuery): Promise<SourceCandidate[]>;
  fetch(candidate: SourceCandidate): Promise<CollectedSource>;
  capabilities(): Promise<ConnectorCapabilities>;
};
```

优先级：

1. 官方 API 或有授权的数据合作方。
2. 企业已购买的舆情/社媒数据 API。
3. MCP Server。
4. 对允许抓取的公开网页使用普通 HTTP/浏览器读取。

所有 Connector 都要执行：租户隔离、速率限制、robots/条款策略、去重、来源快照、内容 hash、删除/下架处理和审计。

Scout 的逻辑产物不是原始帖子列表，而是：

- Observation：原文片段、语言、场景、身份线索。
- Hypothesis：对动机或模式的暂定解释。
- Validation Query：寻找支持和反例的查询。
- Persona Candidate：有证据范围和时效的画像候选。

## 11. 安全、权限和合规

- 所有业务表带 `workspace_id`，RLS 和服务端授权双重校验。
- `user` scope Context 只对创建者可见；workspace scope 要求成员身份。
- Public share token 使用高熵随机值，可撤销、可设置有效期。
- Team API Key 只存 hash，支持 scope、最后使用时间、轮换和撤销。
- Impersonation token 一次性或短时有效，绑定 team、user、callback allowlist。
- Prompt 中的网页和附件视为不可信输入，防止 prompt injection 影响工具权限。
- Skill 无权自行扩大 capability；外部 HTTP/MCP 访问要有 allowlist。
- 删除 Context 时使用 tombstone，并保证后续检索不再返回；审计记录按合规要求保留。
- 真人访谈保存同意状态、用途、保留期限和撤回处理。

## 12. 分阶段实施计划

### P0：冻结证据和恢复基线，1 周

- 保留旧站 HTML、截图、sitemap、公开研究回放和关键工程文章快照。
- 建立“原产品事实 / 重建实现 / 未确认推测”三栏台账。
- 为当前数据库跑完整 migration smoke test。
- 固化核心路由 screenshot 和行为快照。

验收：任何“原平台就是这样实现”的陈述都有证据等级和来源。

### P1：可信研究闭环，2-4 周

- [x] 完成 Evidence Source/Item、Claim、Claim Evidence 表。
- [x] 报告改为不可变 version + 结构化 node，并加入逐条 citation。
- [x] 合成访谈和真人访谈在 UI、公开分享和 Prompt 中强制区分；公开分享对真人 evidence 服务端脱敏。
- 所有数字增加 metric provenance；无来源数字不允许发布。
- [x] Report version 与 workspace/share 读取对齐；历史报告保持 legacy，不推测回填。

验收：随机抽取十条报告结论，全部能打开直接证据或显示“模型推断/无外部证据”。

### P2：动态 GEA Runtime，3-5 周

- [x] Brief/澄清先生成版本化 Intent Contract；`intent_planning` Context Snapshot、确认版 Plan、编译后的 WorkflowDefinition 和 Run 保持精确绑定。
- [x] Plan 确认生成不可变版本和内容 hash，Run 通过同 Study 外键锁定精确 Plan Version；历史仅作明确的 `legacy_backfill`，不推测修改轨迹。
- [x] 增加版本化 `reasoning_decisions`、候选动作和白名单动态追加任务。
- [x] 实现 coverage/conflict/novelty/budget 扩展停止条件，并保证固定必需任务继续执行。
- [x] 完善单 task retry、waiting_input、resume、cancel。
- [x] Runtime 与 UI 使用同一持久化 decision/task/event 数据源，回放不依赖前端推演。
- [x] 增加批量研究跨 Run Replay/API，对比 Plan、运行时版本、Context、Skill、任务、决策、checkpoint 和产物 hash。

验收：模拟 Provider 超时、单 Persona 失败、Worker 重启和用户取消，运行可恢复且不重复生成 artifact。

### P3：Scout 与 Context 增强，3-6 周

- [x] 接入真实 Tavily/Bing Search Provider，并将 Provider 搜索结果约束为候选发现，不作为未经采集的事实证据。
- [x] 增加合规 Public Web Connector、robots/公网/重定向/类型/大小/访问限制检查，以及不可变 Snapshot、Observation、hash 和 tombstone。
- [x] 接入 Bluesky 公共 AppView/XRPC Social Connector；搜索候选必须再经 `app.bsky.feed.getPosts` 形成不可变 Snapshot/Observation 才可进入 Evidence。当前不声称具备小红书、抖音、X、Instagram 的非公开 API 权限。
- [x] 大体积原始内容迁入 S3 兼容对象存储；超过阈值的正文按 workspace + SHA-256 内容寻址外置，PostgreSQL 仅保留不可变对象 locator、字节数、etag/version、hash 和标准化摘录，小正文继续受限内联以避免无意义网络开销。
- [x] Context 增加 `hybrid_v1`、版本化 retrieval evaluation dataset、tombstone/reindex 和历史 snapshot 保留。
- [x] 研究报告与新生成 Persona 自动形成带 origin/provenance 的待审核 Context 候选；批准前不进入检索，重试不重复创建。
- [x] 从报告证据图生成 evidence-grounded Persona，并增加显式保留/淘汰策略；仅允许 Evidence locator 精确匹配，历史 Persona 保留 `ungrounded`。
- [x] 从锁定 Workflow 与最终 Report 自动提出 Research Template / Knowledge Gap；使用待审核、内容指纹去重、来源边、365/180 天有效期和 `resolved_by` 解决归档治理，不自动批准；重复候选审计按候选、Study、Report 组合保持幂等。
- [x] 将 Core/Working/Team Memory 统一到 Context Asset；实现用途、主体、有效期、审核和不可变 policy version，Working Memory 只能基于已审核观察晋升为 pending Core/Team 候选。
- [x] 建立授权 source 的版本化 Agent Eval 和可回放动态 Context retrieval：自动 judge 与人工标签分离，Reasoning 只在不足、冲突或时效到期时受预算上限控制地刷新 Context。
- [x] 建立人工 relevance 标注工作台和合法来源门禁；标签保存标注人、时间、理由及不可变来源快照，历史未验证 case 不回填为人工标签。

验收：Scout 每条观察可回到原始来源；下架或无权访问内容不会泄露到公开报告。

### P4：平台能力，按业务需要推进

- [x] 受控 HTTP JSON / MCP Streamable HTTP client executor、工作区启停与 Run 级版本锁定。
- [x] Market Insight 第二产品线复用同一 Intent/Plan/Workflow/Run/Skill/Context 契约，并以独立模板、任务图和输出契约锁定到 Run。
- [x] Universal Agent 与通用代码 Skill sandbox；会话、消息、Run、步骤和 workspace 文件持久化，代码只交给 allowlist 内的外部隔离 Runner。
- [x] Workspace scoped API keys、哈希鉴权、精确 scope、撤销/过期和外部调用审计。
- [x] 对外无状态 MCP server；复用 API key 契约，每个 tool 单独做 scope 判断。
- [x] 跨工作区不可变发布包、接收审核、撤回归档、委托状态机和事件审计；公开 share token 不承担协作授权，接收资产只生成待治理引用。
- [x] 多 Provider 成本/质量路由后台；策略按阶段版本化，显式保存价格来源、质量/延迟/成本门槛与候选权重，Run 绑定精确版本并记录每次决策、用量、成本和延迟。
- Fast Insight、Podcast、Sage 等第二产品线。

## 13. 当前仓库差距与建议顺序

当前已经完成或接近完成：

- 产品页面和工作台的主要视觉恢复。
- Plan confirmation、Study/Run/Task/Artifact/Checkpoint/Queue。
- Persona、Panel、AI/真人 Interview。
- Skill/Context 版本化基础。
- DAG 并发、provider 限流、实验分组和运行取消基础。
- 持久化实时访谈 Agent、公开邀请页双模式、会话恢复/取消和逐轮幂等。
- 实时会话 Skill/Context/策略版本回放、六维人工质量评分与实验指标聚合。
- 跨 realtime experiment variant 的指标表、候选会话选择和双侧版本化 transcript/Context/review 回放。
- Evidence Source/Item → Claim Evidence → Claim → Report Version/Node 证据链，以及逐条引用和公开分享隐私边界。
- ReasoningDecision → 候选动作 → 动态任务/停止条件 → checkpoint replay 的确定性调度闭环。
- Connector Run → Source Candidate → immutable Snapshot/hash → Observation → Evidence 的公开来源审计闭环。
- Bluesky `searchPosts` candidate → `getPosts` collection → immutable social Snapshot/Observation → Evidence 的官方公共 API 证据闭环；默认关闭，部署时显式启用，不包含登录绕过或私有平台接口。
- Raw source → 64 KiB 阈值 → workspace scoped SHA-256 S3/MinIO object → immutable database locator 的大正文外置闭环；对象写入先于数据库事务，事务失败只补偿删除本次新建对象。
- Context Asset/Version → FTS + embedding baseline → Retrieval Snapshot → Evaluation Run 的可复现检索闭环，以及 tombstone/reindex 审计。
- Approved Human Research Sample → Human Relevance Label → immutable source snapshot → Baseline/Candidate Gate 的人工检索评估闭环；20 条用户确认标签、Baseline、火山方舟与百炼 Candidate 均已完成，两个 Candidate 都未进入 shadow index。
- Context Candidate → governance/review → active retrieval 的资产飞轮；研究报告与 synthetic Persona 具备 origin 幂等、来源 hash、受控关系和事件审计。
- Persona → exact Evidence locator → Claim → grounding summary → retention/expiry governance 的可审计复用闭环；Context 批准与 Persona 保留互不替代。
- Context Asset → Memory Binding → Purpose Policy → Retrieval Decision 的排序前门禁，以及 Working Memory → approved Observation → pending Core/Team candidate 的双重审核闭环。
- Workspace Skill → Enable Setting → immutable Run Binding / audited Execution 的受控执行闭环，支持 HTTP JSON 与 MCP Streamable HTTP client。
- `.skill` / `SKILL.md` → submitted → immutable capability grants → approved/active → health/revoke 的声明式包治理闭环；secret 仅引用环境变量，Run 绑定快照保留授权范围。
- Workspace A immutable Publication Snapshot → Workspace B pending governed reference，以及 Publication-linked Delegation 的跨工作区协作闭环；草稿、撤回和第三方工作区均保持隔离。
- Routing Policy → immutable Version/Route price metadata → per-stage Run Binding → Provider Decision ledger 的真实调用闭环；策略实验继续负责分组，路由策略负责 Provider 选择。
- Brief → governed `intent_planning` Retrieval Snapshot → immutable Intent Version → confirmed Plan Version → compiled WorkflowDefinition → Run 的版本锁定闭环；Runtime 从锁定任务图执行，Replay 分开展示 Planning/Execution Context。
- Product Line → Intent/Plan snapshot → Research 或 Market Insight WorkflowDefinition → 同一 Runtime/SkillInvocation/Replay 的跨业务线复用闭环；Market Insight 默认排除 Persona 与合成访谈。
- Completed Study → locked Workflow / final Report → pending Template / Gap → review / dedupe / expiry / resolution → governed Context reuse 的研究资产闭环；7 个历史模板和 84 个 Gap 已回填但仍待人工审核。
- Universal Agent Thread → immutable Run Skill Binding → structured action step → persistent workspace file / sandbox execution → Provider routing decision 的可审计通用执行闭环。

下一批最值得做的工作，按收益排序：

1. [x] 建立 Evidence-grounded Persona 与 Memory/Context Policy，保证长期资产的证据、用途、主体、时效和审核可追溯。
2. [x] 实现版本化 `IntentContract -> WorkflowDefinition`：在 Plan 前明确目标、预算、数据范围、合规策略与允许的 Memory purpose，并保存解析依据和用户确认版本。
3. [x] 让 Intent Planning 真正读取已批准 Team/Core Memory、相似 Study 和可复用 Persona，同时在 Run Replay 中展示哪些 Context 改变了 Plan。
4. [x] 增加 Market Insight 第二条 workflow，用真实复用验证 `WorkflowDefinition + RuntimeContext + SkillInvocation` 是通用契约，而不是提前重写 Runtime。
5. [x] 在现有 Skill Gateway 上增加 `.skill` / `SKILL.md` 导入导出、capability grants、签名声明/撤销、executor health probe 和 scoped credential reference；随后完成 `atypica.skill/v2` 代码包、`code_execute` grant 与外部隔离 sandbox Runner 契约。
6. [x] 建立授权 source 的“虚构引用”和“Persona 回答趋同”Agent Eval 契约，并让 Reasoning 在不足、冲突或时效到期时产生可回放的动态 Context retrieval；真实黄金样本仍须经独立审批后导入。
7. [x] 从 20 份 CC BY 4.0、匿名化且明确同意发布的英文访谈转录建立 20 条 relevance case。用户已确认将 P4 替换为直接说明回答质量判断标准的 `cxc_WNmfyFvjo3GckbgA`；新评估集 `ces_gDD0245-3Ua1zruu` 与 Baseline Run `cer_Vkm2YEc8flA4n86Q` 已创建，Precision@K 为 `0.025`、Recall@K 为 `0.20`、MRR 为 `0.0783`。旧集 `ces_QOFfpNrsvXkfX5aw` 已归档供历史复现。
8. [x] 已完成两种生产 embedding 候选的同集对照。火山方舟 `Doubao-embedding-vision 251215` Run `cer_jEggoOiHVMtdO4df` 的 P@K `0.03125`、R@K `0.25`、MRR `0.04762`；百炼 `text-embedding-v4` Run `cer_BWVjZC6Z4gMhEWyr` 的 P@K `0.0125`、R@K `0.10`、MRR `0.0625`。两者均未通过 MRR `+0.03` 且 P@K/R@K 不下降的门槛，因此不开启 pgvector/HNSW。
9. [x] 自动沉淀研究模板和 Knowledge Gap：管理员审核、SHA-256 内容指纹去重、模板 365 天/Gap 180 天过期退出检索、`resolved_by` 解决归档均已实现；7 份历史报告已幂等回填 7 个模板和 84 个 Gap，全部待审核。
10. [x] `.skill` 治理和第二产品线稳定后，已开放 workspace scoped API keys 和无状态 MCP server；团队发布流仍待完成。
11. [x] Scout 已增加 Bluesky 官方公共 AppView Connector，并严格区分搜索发现与可引用快照；当前网络环境无法完成官方站点实时连通验证，因此部署验收仍需执行一次真实 API smoke。
12. [x] Source Snapshot 大正文已迁入 S3 兼容对象存储；隔离 PostgreSQL smoke 和本地 MinIO 的不可变复用、hash 元数据及回读完整性均已验证。
13. [x] Universal Agent 工作台已完成：支持持久化会话/文件、结构化动作循环、每轮外部执行确认、精确 Skill 版本锁定、Sandbox 审计和 Provider 路由账本。

不建议现在做：

- 改写为 FastAPI 微服务。
- 引入 LangGraph 重写现有 harness。
- 在没有评估集时训练“Subjective World Model”。
- 为了架构图好看而提前加入 Kafka、RabbitMQ、Redis、Milvus 或 Kubernetes。
- 复刻公开报告中没有证据支持的样本量、百分比和真人引语。

## 14. 总体验收标准

### 产品一致性

- 用户可以从一句 Brief 走到确认计划、运行研究、查看 Panel、访谈、报告、分享和追问。
- Study Replay 能复现工具事件、失败、重试和 artifact 产生顺序。
- 报告和研究是两个独立分享对象。

### 运行可靠性

- Worker 中断后从 checkpoint 恢复。
- task/invocation 幂等，不重复扣费或生成重复 artifact。
- workspace/provider 并发、速率、预算、超时和取消有效。
- 所有 Provider 失败都有明确分类和可重试性。

### 证据可信度

- 事实、真人观察、合成模拟和模型推断有不同标识。
- 每个百分比都有计算来源。
- 每个引用可以定位到原文、访谈 turn 或结构化计算输入。
- 报告公开分享不会越权暴露私有 Context。

### 可演进性

- Skill、Context、Prompt、Plan、Report 和策略均版本化。
- Research、Product R&D、Fast Insight 可以共享 Runtime，而不共享硬编码流程。
- Provider 和数据源可以替换，不影响业务对象和报告证据模型。

## 15. 公开参考

- [GEA：从 atypica 的实践看企业 AI 系统的构建](https://atypica.ai/engineering/gea-architecture)
- [Universal Agent + Skills 教程](https://atypica.ai/engineering/universal-agent-skills-from-scratch)
- [设计自然的 AI 记忆](https://atypica.ai/engineering/designing-natural-ai-memory)
- [Atypica 功能与对比](https://atypica.ai/features)
- [Plan Mode](https://atypica.ai/features/plan-mode)
- [Scout Agent](https://atypica.ai/features/scout-agent)
- [Bluesky API: app.bsky.feed.searchPosts](https://docs.bsky.app/docs/api/app-bsky-feed-search-posts)
- [Bluesky API: app.bsky.feed.getPosts](https://docs.bsky.app/docs/api/app-bsky-feed-get-posts)
- [公开报告示例](https://atypica.ai/artifacts/report/tNaAeztyDmMEPF2A/share)
- [公开研究回放示例](https://atypica.ai/study/rTLbG4tYpR4zsGq4/share?replay=1)

说明：公开网页会继续变化。仓库中的 `recovery/reference/` 是本次恢复工作的本地证据基线，公开报告仅用于理解产品行为，不应批量复制用户生成内容。
