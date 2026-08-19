# Universal Agent 执行能力 Phase 2

日期：2026-08-19

## 本阶段目标

让用户在 Agent 运行期间看到可审计的决策和工具生命周期，并为产品原生能力建立最小自动化保护。

## 已完成

- 新增 `/api/agent/threads/[publicId]/events` SSE Route Handler。
- SSE 以 `agent_steps.id` 作为单调游标，支持 `Last-Event-ID` 和 `after` 查询参数。
- 事件按 `run` 参数绑定到当前 Agent Run，避免把历史运行混入当前时间线。
- 前端在运行期间订阅 `agent-step`，显示决策摘要、工具名称、状态和失败码；页面快照仍是最终权威状态。
- 执行确认文案从“Skill”调整为“能力”，覆盖外部 Skill 和原生产品工具。
- 新增 `universal-agent-product-tools-smoke`，覆盖产品能力目录、输入校验和副作用授权门槛。
- 扩展隔离 Universal Agent smoke，校验 SSE 所需的步骤 ID 单调性、Run 过滤和工作区隔离查询；已在本机 Docker PostgreSQL 临时库通过。

## 事件边界

SSE 只发送可审计字段：步骤类型、状态、序号、短摘要、工具名、结果摘要和错误码；不发送模型隐藏推理、完整系统 Prompt 或未脱敏密钥。

断线后客户端应携带最后的事件 ID 重连。服务端不会删除运行记录，事件回放仍以数据库中的 `agent_steps` 为准。

## 下一阶段

1. 在浏览器端增加运行时间线筛选和失败步骤重试入口。
2. 对 `agent_steps.output` 做输出摘要/大小上限，避免大报告直接进入 SSE。
3. 在本地 Postgres 隔离库运行扩展 smoke，验证 SSE 权限隔离、游标续传和跨 Run 过滤（已完成）。
4. 对产品工具补充完整成功路径 smoke，并纳入 CI；需要模型的访谈/研究执行继续使用隔离环境确认变量。
5. 增加每个 Agent Run 的预算、最大工具调用次数和指标记录。

## 部署验收发现

登录后的浏览器验收确认 UI、同源登录和 SSE 时间线均正常；但连接远程 Supabase 的队列 Worker 仍运行 `universal-agent-v1`，因此真实请求没有看到 `persona.list`，而是返回“没有可用内置产品工具”。发布时必须同步部署 `scripts/research-worker.mjs` 与 `src/lib/universal-agent.ts`，不能只更新 Next Web 进程。新增 `AGENT_RUN_PUBLIC_ID` 定向参数可用于单 Run 恢复和灰度验证。

Worker 启动时会输出结构化版本日志：

```json
{"event":"research_worker_started","agentPromptVersion":"universal-agent-v2-product-tools"}
```

只核对部署包版本、不领取任务时运行：

```bash
pnpm exec tsx scripts/research-worker.mjs --version
```

部署后先检查该日志，再创建最小验收 Run。验收 Run 的 `agent_steps.output.promptVersion` 和 Worker 启动日志必须一致；如果仍为 `universal-agent-v1`，应停止验收并继续发布 Worker，而不是修改用户提示词。

单 Run 灰度验收使用 Agent-only 模式，避免误处理研究或访谈队列：

```bash
AGENT_WORKER_AGENT_ONLY=1 AGENT_RUN_PUBLIC_ID=<runPublicId> pnpm research:worker:once -- --agent-only
```
