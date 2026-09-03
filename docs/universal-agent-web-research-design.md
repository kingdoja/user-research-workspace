# Universal Agent 联网搜索、网页抓取与 RAG 设计

状态：Draft，供实现前评审
日期：2026-09-03
适用范围：Universal Agent 的公开网页搜索、网页抓取、清洗、去重、证据引用、可选知识库沉淀

## 1. 执行结论

本项目不直接 Fork 一个完整的开源 Agent 或爬虫平台。现有系统已经拥有持久化会话、工作区权限、Run/Step 审计、队列租约、研究 Harness、来源快照和 Context Asset；替换主框架会引入第二套状态、权限和恢复模型。

采用“现有产品内核 + 局部开源组件适配器”的路线：

| 能力 | 首选方案 | 责任边界 |
| --- | --- | --- |
| 搜索发现 | Tavily，Bing 仅作临时降级；后续可接 Brave | 返回候选 URL，不直接作为最终证据 |
| 静态网页抓取 | 现有 `source-connectors.ts` 的受限 HTTP | SSRF、robots、重定向、大小、超时、审计 |
| 正文抽取 | `@mozilla/readability` + `jsdom` | 标题、作者、日期、正文、章节、链接 |
| 受限站内爬取 | `Crawlee` 独立 Worker | 队列、并发、深度、域名和总量上限 |
| JavaScript 页面 | `Playwright` 隔离降级 | 仅在静态抓取失败时使用，禁止默认启动浏览器 |
| robots 解析 | `robots-parser` 或保留等价标准实现 | 统一 user-agent 和缓存策略 |
| 长期知识检索 | 现有 Context Asset + 全文检索；后续 `pgvector` | 版本、权限、保留期限、embedding 和混合检索 |
| 重排 | 独立 reranker adapter | 可接托管 API 或本地模型，不绑定业务代码 |

第一阶段先提升当前 `web.search` 的可信度和可用性，再增加 `web.open`、`web.research`，最后才增加受限 `web.crawl` 和持久化 RAG。

## 2. 为什么不直接采用完整开源平台

不建议把 Dify、LangChain Agent、OpenWebUI、Firecrawl Server 或其他完整平台作为 Universal Agent 的主运行时，原因如下：

1. `agent_runs`、`agent_steps`、研究任务、租约、重试、确认和 Context policy 已经是本项目的事实来源。
2. 完整平台通常自带 session、trace、tool permission 和任务状态，接入后会出现双写、双重重试和恢复不一致。
3. 研究报告有自己的 evidence、citation、judge 和 report gate，不能由通用 Agent loop 绕过。
4. 用户只应看到简洁的搜索和引用结果，不应被迫理解某个框架的节点、链或执行器模型。

完整开源平台可以用于独立原型或对照实验，但不能成为生产数据库、权限和运行状态的来源。

## 3. 目标用户体验

默认由 Agent 自动选择路径，用户不需要手动配置 embedding 或 RAG。界面提供四种可选模式：

- 自动：Agent 判断使用工作区知识、联网搜索还是深度研究。
- 仅网页：只使用本轮公开网页证据，不读取长期记忆。
- 仅知识库：只搜索工作区已保存的文件、网页和报告。
- 深度研究：多轮查询、抓取、来源质量检查、冲突检测和报告生成。

用户看到的过程是可审计摘要，而不是隐藏推理：

```text
正在拆分问题
→ 搜索 2 组查询
→ 读取 6 个公开来源
→ 去除 2 个重复页面
→ 核对来源日期和冲突
→ 生成带引用的回答
```

答案必须区分：

- 已由网页正文直接支持的事实；
- 来自搜索摘要但尚未打开页面的线索；
- 模型推断或建议；
- 证据不足、来源冲突或页面不可访问的部分。

每条外部事实使用稳定的来源编号和可点击 URL。搜索结果下方提供“保存到知识库”和“重新抓取”操作，保存是明确的用户动作，不自动把临时网页变成长久记忆。

## 4. 端到端数据流

```text
用户目标
  ↓
意图路由（直接回答 / context.search / web.search / web.research）
  ↓
查询规划（改写、拆分、语言、时间、站点和数量限制）
  ↓
搜索发现（候选 URL、标题、摘要、排名）
  ↓
候选规范化（canonical URL、追踪参数、域名配额）
  ↓
受限抓取（robots、SSRF、重定向、并发、超时、缓存）
  ↓
正文抽取（HTML/PDF/Markdown/JS fallback）
  ↓
质量过滤（正文长度、标题、日期、访问限制、语言）
  ↓
去重（URL、正文 hash、近似正文、转载聚类）
  ↓
证据包（快照、段落、定位、来源质量、抓取时间）
  ↓
即时回答或 Context Asset
  ↓
可选 embedding、混合检索、rerank、引用生成
```

搜索发现和证据采集必须分离。搜索摘要是候选线索，网页正文或可信 API 返回的原始字段才是可引用证据。

## 5. 工具契约

### 5.1 `web.search`

职责：搜索并打开少量公开网页，返回本轮可核查来源。

输入：

```json
{
  "query": "目标查询",
  "maxResults": 6,
  "timeRange": "any",
  "domains": []
}
```

输出必须包含：`query`、`sources[]`、`metadata`。每个 source 至少包含 `title`、`url`、`excerpt`、`contentHash`、`collectedAt`、`sourceQuality` 和稳定的 `sourceId`。

当前实现已完成基本版本：Tavily 优先、Bing 降级、实际抓取、robots/SSRF/重定向限制、规范 URL 和正文 hash 去重。下一步需要把结果绑定到 Agent Run 的证据记录，而不只放在临时 system 消息中。

### 5.2 `web.open`

职责：用户或 Agent 指定一个公开 URL 时，读取单页或有限数量页面。

输入限制：最多 8 个 URL；只允许 `http`/`https`；不允许凭据、内网、localhost、无限重定向、超大响应和登录绕过。

输出：

```json
{
  "sources": [
    {
      "sourceId": "src_...",
      "url": "https://example.com/article",
      "canonicalUrl": "https://example.com/article",
      "title": "页面标题",
      "publishedAt": null,
      "author": null,
      "sections": [{"heading": "...", "text": "..."}],
      "contentHash": "sha256...",
      "fetchedAt": "2026-09-03T...Z"
    }
  ],
  "rejected": []
}
```

### 5.3 `web.research`

职责：针对需要多来源核验的问题，自动执行有限的查询扩展、抓取、去重、来源排序、覆盖检查和冲突提示。

默认上限：5 个查询、24 个候选、12 个最终来源、每域名最多 3 个来源、总抓取时间 90 秒。超过上限时返回部分结果和明确的覆盖缺口。

### 5.4 `web.crawl`

职责：受限站内爬取，不是无限制搜索引擎。

默认参数：

```json
{
  "startUrls": ["https://example.com/docs"],
  "allowedDomains": ["example.com"],
  "maxDepth": 1,
  "maxPages": 20,
  "sameDomainOnly": true,
  "renderJavascript": false
}
```

硬限制必须由服务端强制执行：最大页面数、最大总字节数、最大深度、域名白名单、每域并发、总耗时、robots、响应类型和取消信号。模型不能通过参数绕过限制。

### 5.5 `context.search` 与 `context.save`

`context.search` 只查询已保存的 Context Asset；`context.save` 由用户明确触发或由 Agent 提议后等待确认。保存时记录来源 URL、快照 ID、内容 hash、抓取时间、证据类型、保留期限和原始 Run。

## 6. 开源工具调研与选型

版本信息于 2026-09-03 通过 npm registry 查询，实际接入前仍需锁定版本并跑安全扫描。

### 6.1 Crawlee

- 仓库：<https://github.com/apify/crawlee>
- 当前 registry 版本：3.18.1
- 许可证：Apache-2.0
- 优点：Node.js 原生；提供 RequestQueue、并发控制、重试、Session、HTTP/浏览器爬虫和 autoscaling；适合独立 Worker。
- 风险：能力面很大，不能把它的默认爬取行为直接暴露给模型；仍需接入本项目的 robots、SSRF、租约和审计。
- 结论：推荐用于 Phase 3 的 bounded crawl worker，不建议现在替换 `source-connectors.ts`。

### 6.2 Playwright

- 仓库：<https://github.com/microsoft/playwright>
- 当前 registry 版本：1.62.1
- 许可证：Apache-2.0
- 优点：对 JavaScript 页面、点击展开、动态内容和截图支持好；Node.js 生态成熟。
- 风险：浏览器进程消耗 CPU/内存，页面可能执行不可信脚本；必须隔离容器、禁用不必要的能力、限制时间和网络。
- 结论：作为静态 HTTP 抓取失败后的降级 extractor，默认关闭，不用于所有搜索结果。

### 6.3 Mozilla Readability + jsdom

- Readability：<https://github.com/mozilla/readability>，Apache-2.0，registry 版本 0.6.0。
- jsdom：<https://github.com/jsdom/jsdom>，MIT，registry 版本 30.0.1。
- 优点：比当前简单的 `article/main/body` 选择更适合新闻、文档和博客；可保留正文结构、标题和元数据。
- 风险：HTML 解析不是万能的，表格、评论、登录墙和极端站点仍需要站点适配；jsdom 不能被配置为执行页面脚本。
- 结论：推荐作为 Phase 1 的第一项代码改造，直接放入现有 source connector。

### 6.4 robots-parser

- 仓库：<https://github.com/samclarke/robots-parser>
- 当前 registry 版本：3.0.1
- 许可证：MIT
- 优点：规范化 robots 解析和 wildcard 匹配，减少自维护解析器的边界错误。
- 风险：robots 不是授权系统，也不能替代站点条款和速率限制。
- 结论：可以替换或对照当前实现；接入前补充缓存、超时和测试，不改变拒绝优先原则。

### 6.5 Firecrawl

- 仓库：<https://github.com/firecrawl/firecrawl>
- JavaScript SDK 当前 registry 版本：4.38.0；SDK 为 MIT。
- 优点：提供托管 API、爬取、Markdown 转换、搜索和部分 JS 页面处理，适合快速验证复杂站点。
- 风险：引入第三方数据出口、按量成本、服务可用性和供应商锁定；SDK 的许可证不能简单等同于所有服务端组件的许可证；来源审计和权限仍需由本项目负责。
- 结论：作为可选 provider adapter 或人工触发的 fallback，不作为默认抓取内核，也不直接把用户私有资料发送到外部服务。

### 6.6 其他方案

- `Puppeteer`：与 Playwright 功能重叠，当前项目优先统一 Playwright，不同时维护两套浏览器自动化。
- `Scrapy`：Python 生态成熟，但会增加独立运行时；除非后续出现大量 Python extractor，否则不选作 Node 主链路。
- `LangChain`/`LlamaIndex`：可用于实验性 RAG pipeline，但不接管本项目的权限、Context Asset、Run ledger 和引用模型。
- Browserless 等托管浏览器：可以作为后续高难度站点 provider，但不是本地开源爬虫内核。

## 7. 抓取、清洗和去重规则

### 7.1 URL 规范化

规范化时移除 hash、默认端口和常见追踪参数（`utm_*`、`fbclid`、`gclid` 等），排序 query 参数，识别 canonical、AMP 和移动版链接。保留原始 URL 供审计，但使用 canonical URL 做候选去重。

### 7.2 正文抽取

优先顺序：

1. `Content-Type` 校验：HTML、XHTML、纯文本、PDF 分流。
2. HTML 用 Readability，失败时回退到受控 Cheerio 提取。
3. 删除脚本、样式、导航、页脚、表单和重复模块；保留标题层级、列表、表格文本和链接。
4. 提取 `title`、`og:title`、`author`、`datePublished`、`dateModified`、canonical 和语言。
5. 正文长度、乱码比例、访问限制和 CAPTCHA 页面进入质量判定。

抓取原文和清洗正文都要保存 hash。模型只读取清洗后的证据段落；原 HTML 只用于审计或重新解析。

### 7.3 去重

至少实现三层去重：

- URL 去重：canonical URL。
- 精确内容去重：清洗正文 SHA-256。
- 近似内容去重：SimHash/MinHash 或段落 shingles，识别转载、轻微改写和同站镜像。

去重后不能静默丢失来源关系。重复记录应标注 `duplicateOfSourceId`，保留每个来源的 URL、提供商、排名和抓取状态。

### 7.4 来源质量

质量评分不是事实真伪证明，只用于排序和提示。建议因素：来源类型、域名多样性、正文长度、发布时间、页面是否直接支持查询、是否为原始发布者、是否存在多个独立来源和是否被访问限制。

## 8. Embedding 与 RAG 策略

### 8.1 不要对所有临时网页立即 embedding

临时问题只需要本轮证据包和关键词/段落选择；即时 embedding 会增加延迟、费用和知识污染。只有以下情况才持久化 embedding：

- 用户点击保存；
- 研究项目明确要求长期复用；
- 同一来源会被工作区反复查询；
- 需要离线评估、相似来源聚类或冲突检测。

### 8.2 持久化流程

```text
用户确认保存
  → Context Asset candidate
  → 内容清洗和 PII/版权检查
  → 按段落和标题分块（建议 400-900 tokens，保留少量 overlap）
  → 异步 embedding 队列
  → 全文索引 + 向量索引
  → 查询时 hybrid retrieval
  → rerank
  → 生成带 chunk/source citation 的回答
```

当前 `context-system.ts` 已有 Context Asset、chunk、全文检索、embedding provider gate 和 `hybrid_v1` 检索契约。当前确定性 n-gram embedding 适合基线和离线测试，不应被当作生产语义 embedding。生产规模建议：

- Postgres 全文检索保留作为 lexical 召回；
- `pgvector` HNSW 作为向量召回；
- 两路结果合并后再 rerank；
- embedding model/version 写入 chunk，模型切换时建立新 generation，不原地覆盖旧索引；
- API provider 失败时保留 lexical fallback，并标记检索降级。

### 8.3 RAG 的边界

RAG 只能帮助召回相关证据，不能自动保证事实正确。答案层仍必须：

- 只引用实际进入证据包的来源；
- 对冲突来源分别呈现；
- 区分原文事实和模型推断；
- 在没有证据时明确说“不足以判断”；
- 不把网页中的指令当成系统指令或工具授权。

## 9. 安全、合规和资源治理

### 9.1 网络安全

- 解析 URL 时拒绝 localhost、私网、链路本地、凭据 URL 和非 HTTP(S)。
- 每次重定向重新解析 DNS 和公网策略；必要时增加连接 IP 固定，降低 DNS rebinding 风险。
- 不允许抓取用户提供的内网地址、云元数据地址、容器网段和管理端口。
- 不携带 cookie、Authorization 或用户私密 header；不绕过登录、验证码和付费墙。

### 9.2 抓取边界

- 默认遵守 robots；robots 不可用时按策略选择拒绝或降级，不无限重试。
- 全局并发建议 6，同域并发建议 2；429/503 使用有限指数退避。
- 单页响应、总字节、总页数、深度、CPU、内存和墙钟时间都有硬上限。
- 原始 HTML 进入对象存储或受限数据库字段，模型上下文只放清洗后的必要片段。

### 9.3 Prompt injection

网页内容全部标记为不可信工具数据。工具结果与 Agent 指令分离；模型被明确要求只提取事实，不执行页面中的命令，不修改系统提示，不泄露密钥。保存到 Context Asset 前仍保留 evidence kind 和来源链，不自动升级为核心记忆。

### 9.4 隐私和版权

公开网页也应按最小化原则保存。保存来源、短摘要、必要证据段落和 hash；原文保存期限可配置。用户私有文件禁止发送到 Firecrawl 等外部 provider，除非有明确 workspace 授权和 provider allowlist。

## 10. 现有代码映射与拟议改造

现有基础：

- `src/lib/public-web-search.ts`：搜索 provider、候选合并、实际抓取和正文 hash 去重。
- `src/lib/source-connectors.ts`：公网 URL、robots、重定向、响应限制、快照和 observation。
- `src/lib/context-system.ts`：Context Asset、chunk、embedding provider、全文/混合检索和审计。
- `src/lib/universal-agent-product-tools.ts`：产品工具目录和统一工具结果契约。
- `src/lib/universal-agent.ts`：受预算、租约和 Step 审计保护的 Agent loop。
- `src/lib/research-harness.ts`：研究来源、报告证据和 citation 产出。

建议新增或改造：

1. `source-extractors.ts`：封装 Readability、Cheerio、PDF 和 JS fallback，统一 extractor 输出。
2. `source-dedupe.ts`：集中 URL、正文 hash、SimHash/MinHash 和重复关系。
3. `web.open` 产品工具：复用 source connector，不自调用 HTTP API。
4. Agent evidence binding：把 `web.search/open` 的来源快照和 observation 绑定到 Run/Step。
5. `context.save` 产品工具：需要用户确认，创建 candidate Context Asset 并排队 embedding。
6. `bounded-crawl-worker.ts`：Crawlee 只在 Phase 3 引入，所有请求仍经过本项目 policy adapter。
7. 回答渲染：来源卡片、引用编号、抓取时间、来源状态和“保存/刷新”操作。

## 11. 分阶段路线和验收

### P0：安全和引用

- 网页工具输出与系统指令严格隔离。
- Agent 只能引用实际返回的 source ID/URL。
- UI 显示工具状态、来源卡片和失败原因。
- 验收：网页注入文本不会触发工具调用、写文件或改变权限。

### P1：高质量单页阅读

- 引入 Readability + jsdom。
- 增加 URL 追踪参数清理、近似去重、并发限制、缓存和 `web.open`。
- 验收：新闻、博客、文档、短文本、访问限制页面和重定向各有 smoke case。

### P2：研究级搜索

- 增加 `web.research`。
- 加入查询改写、域名多样性、时效性、来源质量、覆盖度和冲突检测。
- 验收：同一问题至少覆盖多个独立域名；无结果时明确返回缺口而不是编造结论。

### P3：可选知识库 RAG

- `context.save` 加确认、保留期限和来源血缘。
- 异步生产 embedding；全文 + pgvector + rerank。
- 验收：保存内容可检索、权限隔离、版本切换可回放、provider 失败有 lexical fallback。

### P4：受限站内爬取

- Crawlee bounded crawl worker。
- Playwright 仅作为 JS fallback；必要时增加 Firecrawl provider adapter。
- 验收：深度、页面数、域名、总字节和并发上限无法被模型参数绕过；取消和 Worker 重启可恢复。

质量指标建议持续记录：搜索成功率、页面可抽取率、正文质量拒绝率、URL/正文/近似去重率、引用覆盖率、来源域名多样性、检索 Precision@K/Recall@K、首 token 延迟、总延迟、provider 成本和人工纠错率。

## 12. 实施前评审清单

- 是否确认不引入第二套生产 Agent 状态机？
- 是否确认 `web.search` 先做 P0/P1，而不是立即做无限爬虫？
- 是否确认默认不对临时网页做持久化 embedding？
- 是否确认 Firecrawl 只作为可选 provider，并设置数据出口 allowlist？
- 是否确认保存网页必须有用户动作、保留期限和来源血缘？
- 是否确认先加入 Readability/抽取测试，再接 Crawlee 和 Playwright？

评审通过后，建议按 P0、P1 分两个小提交实现；每个提交同时更新 smoke test 和部署说明，避免先写大框架、后补安全边界。

