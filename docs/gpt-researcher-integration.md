# GPT Researcher Bridge

当前项目可以把 `gpt-researcher-personal` 作为研究执行引擎，当前项目继续负责登录、workspace 隔离、权限、任务队列、审计、来源入库以及报告 judge/revision/finalize。

## 启用

在两个服务之间配置同一个随机 token：

```env
# GEA Next.js
RESEARCH_ENGINE=gpt-researcher
GPT_RESEARCHER_URL=http://127.0.0.1:8000
GPT_RESEARCHER_BRIDGE_TOKEN=replace-with-a-long-random-secret
GPT_RESEARCHER_TASK_TIMEOUT_SECONDS=900
GPT_RESEARCHER_BRIDGE_RUN_TIMEOUT_SECONDS=720
GPT_RESEARCHER_IDLE_TIMEOUT_SECONDS=120
GPT_RESEARCHER_FALLBACK_TO_LOCAL=true
GPT_RESEARCHER_BRIDGE_TTL_SECONDS=21600
GPT_RESEARCHER_BRIDGE_EVENT_LIMIT=2000

# gpt-researcher-personal
GPT_RESEARCHER_BRIDGE_TOKEN=replace-with-a-long-random-secret
# Same optional retention/event limits may be set here for the Python bridge.
GPT_RESEARCHER_BRIDGE_TTL_SECONDS=21600
GPT_RESEARCHER_BRIDGE_EVENT_LIMIT=2000
```

### 本机已验证的模型组合

当前本机的 `yundu.lat` 无法建立连接。要继续使用 GPT Researcher，可让不同组件使用各自可达的服务：DeepSeek 负责 GPT Researcher 的规划/执行/写作，Qwen `text-embedding-v4` 负责网页相关性压缩，Tavily 负责搜索。将下面的非密钥配置放入 bridge 的 `.env`，密钥填入对应服务自己的值：

```env
GPT_RESEARCHER_BRIDGE_TOKEN=<与 GEA 相同的 token>
DEEPSEEK_API_KEY=<DeepSeek key>
FAST_LLM=deepseek:deepseek-v4-flash
SMART_LLM=deepseek:deepseek-v4-pro
STRATEGIC_LLM=deepseek:deepseek-v4-pro
RETRIEVER=tavily
LANGUAGE=chinese

# GPT Researcher 当前版本把 custom embedding 通过 OPENAI_* 变量创建。
# 这里的 OPENAI_* 仅指向 Qwen embedding，不影响上面的 deepseek LLM。
EMBEDDING=custom:text-embedding-v4
EMBEDDING_KWARGS={"chunk_size":8}
OPENAI_BASE_URL=<QWEN_EMBEDDING_BASE_URL>
OPENAI_API_KEY=<QWEN_EMBEDDING_API_KEY>
OPENAI_EMBEDDING_MODEL=text-embedding-v4
```

bridge 启动时使用 `main.py`，它会加载自身目录下的 `.env`：

```bash
cd /path/to/gpt-researcher-personal
./.venv/bin/python main.py
```

启动后先验证：

```bash
curl http://127.0.0.1:8000/health
```

Qwen embedding 的批量上限在不同租户可能是 10 或 20，`EMBEDDING_KWARGS={"chunk_size":8}` 留出余量；否则会出现 `batch size is invalid`，子查询被跳过，最后报告可能为空。

启动 Python 服务后，当前项目的 `deepResearch` 会调用 `/v1/research/runs`，通过 `/v1/research/runs/{id}/events` 接收 SSE。Python 服务只返回研究事件、来源和 Markdown 草稿，不接触 GEA 数据库。

`scoutSocialTrends` 始终使用轻量的社交/公开网页连接器，不会为每个平台扫描启动一个完整 GPT Researcher 报告。`deepResearch` 才使用外部引擎，并使用独立的任务时限。外部引擎连续 `GPT_RESEARCHER_IDLE_TIMEOUT_SECONDS` 秒没有业务进度、超过总时限或返回不可入库来源时，默认回退到本地 DeepSeek/Tavily 路径；可将 `GPT_RESEARCHER_FALLBACK_TO_LOCAL=false` 改为严格失败。

可用 `GET http://127.0.0.1:8000/health` 做存活检查。桥接服务会清理超过 TTL 的已结束任务，并把单个任务的可重放事件限制在 `GPT_RESEARCHER_BRIDGE_EVENT_LIMIT` 以内；当前实现仍是单进程内存状态，不能直接用于多 worker 生产部署。

## 报告类型配置

在新建研究页的“GPT Researcher 报告类型”选择器中选择。选择值会写入 GEA 的 `study_plans.gpt_researcher_report_type`，确认计划时复制到不可变的 `study_plan_versions.gpt_researcher_report_type`，随后写入确认工作流的 `task_graph`，由 `deepResearch` 任务传给 Python bridge 的 `report_type`。

当前可选类型：

- `research_report`：标准报告，默认值。
- `deep`：更深的检索与分析。
- `detailed_report`：详细报告，GPT Researcher 内部会继续拆分子主题。
- `subtopic_report`：单个子主题报告。

这只改变公开资料研究阶段的草稿和来源发现策略。GPT Researcher 的 Markdown 不会直接成为最终报告；GEA 仍会把来源、草稿、Persona/访谈/讨论结果送入结构化报告生成，再经过 judge、revision 和 finalize。

## 报告质量边界

GPT Researcher 的 Markdown 仅作为研究草稿和流式预览。最终报告仍由当前项目的结构化 report stage 生成，并继续经过 evidence catalog、citation binding、answerability boundary、judge、revision 和 finalize。不要把 Python 服务的 `/report/` 本地文件接口直接暴露给浏览器，也不要绕过 `research.run_confirmed`。

Universal Agent 采用两阶段模型调用：第一阶段只输出结构化动作并执行受治理工具；第二阶段在 `finish` 后使用普通文本流生成最终回答。结构化 JSON 不再作为用户正文流式展示，因此 DeepSeek 返回完整 JSON 也不会阻塞最终回答的增量显示。

最终回答默认使用 Chat Completions 流式协议；如果内部网关只稳定支持 Responses，可设置 `UNIVERSAL_AGENT_FINAL_PROTOCOL=responses`。

## 本地验证

```bash
pnpm exec tsc --noEmit
pnpm exec eslint src/lib/gpt-researcher-adapter.ts src/lib/openai-provider.ts src/lib/research-harness.ts
python3 -m py_compile /path/to/gpt-researcher-personal/backend/server/app.py
```

桥接 API 是进程内运行状态，单进程适合开发和单 worker 部署。生产多 worker 时，应把 run/event 状态迁移到 Redis 或独立队列，并在内网或 service mesh 中限制 Python 服务访问来源。
