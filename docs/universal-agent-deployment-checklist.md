# Universal Agent 部署验收清单

适用范围：Universal Agent 产品工具、Run 预算治理和安全重试能力。

## 1. 发布前检查

- [x] 已通过 `pnpm exec tsc --noEmit`、`pnpm lint` 和 `pnpm exec next build --webpack`（2026-08-22，本地）。
- [ ] 生产 Web 环境已设置 `PUBLIC_APP_ORIGIN=https://<正式域名>`；未设置时禁止带 Origin 的状态变更请求。
- [ ] 主机防火墙只开放 80/443；Next 的 3000 和 Sandbox Runner 的 8787 不得直接暴露公网。
- [ ] 主站使用 `deploy/Caddyfile.app.example`（替换正式域名），Next 只监听内部端口，代理覆盖客户端转发头。
- [ ] Caddy/Nginx 已清理客户端传入的 `X-Forwarded-Host` 和 `X-Forwarded-Proto`，只转发代理计算的值。
- [ ] 生产入口已在 WAF/网关或 Redis-backed limiter 上配置登录、注册、邀请提交和高成本执行接口的分布式限流；应用内 limiter 仅作为单实例兜底。
- [x] 已通过 `pnpm smoke:universal-agent-product-tools`（2026-08-22）。
- [ ] 已在本地隔离 PostgreSQL 运行两项 smoke：

```bash
LOCAL_SMOKE_DATABASE_URL=postgresql://postgres:<local-password>@127.0.0.1:5432/postgres \
  pnpm smoke:isolated universal-agent
LOCAL_SMOKE_DATABASE_URL=postgresql://postgres:<local-password>@127.0.0.1:5432/postgres \
  pnpm smoke:isolated universal-agent-product-tools
```

不要把真实数据库密码写入 shell 历史、CI 日志或文档；优先通过受控 Secret 注入。

## 当前验收记录（2026-08-22）

- 本地 Worker 版本已确认：`universal-agent-v2-product-tools`。
- 本地生产构建、TypeScript、lint 和产品工具 smoke 已通过。
- 尚未执行远程 Web/Worker 发布、远程数据库迁移或生产重启。
- 隔离 PostgreSQL smoke 需要受控的本地数据库连接后再执行，不能使用生产连接替代。

## 2. 数据库迁移

按文件名的时间顺序应用迁移：

1. `supabase/migrations/20260821010000_universal_agent_run_governance.sql`
2. `supabase/migrations/20260821020000_universal_agent_run_retry.sql`
3. `supabase/migrations/20260903010000_agent_source_evidence_refs.sql`
4. `supabase/migrations/20260903020000_agent_stream_events.sql`
5. `supabase/migrations/20260903030000_universal_agent_search_budget.sql`
6. `supabase/migrations/20260903040000_expand_universal_agent_budget.sql`

本次新增迁移创建 `agent_step_source_refs`，把 `web.search` / `web.open` 返回的来源绑定到具体 Agent Run/Step。迁移是幂等的；应用后检查：

```sql
select to_regclass('public.agent_step_source_refs');
select to_regclass('public.agent_run_stream_events');
```

迁移只新增 Run 预算字段、约束、重试血缘字段和索引，不删除历史 Run。应用后检查：

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'agent_runs'
  and column_name in (
    'max_tool_calls', 'max_product_tool_calls', 'max_external_tool_calls',
    'token_budget', 'max_cost_micros', 'retry_of_run_id'
  )
order by column_name;
```

## 3. Worker 发布

Web 进程和队列 Worker 必须来自同一版本。先在 Worker 环境执行：

```bash
pnpm exec tsx scripts/research-worker.mjs --version
```

启动日志中的 `agentPromptVersion` 应为 `universal-agent-v2-product-tools`。如果仍是旧版本，停止验收并继续发布 Worker。

流式回答验收：发送一个只需文字回答的短问题，提交后应先看到“实时输出”草稿，再看到最终助手消息。SSE 事件类型为 `agent-stream`，断线重连使用复合 `Last-Event-ID` 游标；若上游网关不支持流式结构化响应，会自动回退为一次性响应，不影响 Run 完成。

## 4. 单 Run 灰度验收

创建一个仅包含测试 Persona/访谈数据的 Run，记录其 `runPublicId`，然后只处理这个 Run：

```bash
AGENT_WORKER_AGENT_ONLY=1 \
AGENT_RUN_PUBLIC_ID=<runPublicId> \
pnpm research:worker:once -- --agent-only
```

确认以下结果：

- `persona.list` 能返回当前工作区资源，跨工作区资源不可见。
- `interview.create` 进入队列且重复请求不会重复排队。
- 未确认的研究计划不会创建 Run/Job；重新确认后才排队。
- `report.read` 只能读取当前工作区报告。
- 失败或阻断 Run 的“重试”会创建新 Run，且 `retry_of_run_id` 指向旧 Run。
- 原 Run 允许副作用时，未重新勾选执行确认不能重试。

## 5. 监控与回滚

重点监控错误码：

- `AGENT_PRODUCT_TOOL_CALL_LIMIT_EXCEEDED`
- `AGENT_TOOL_CALL_LIMIT_EXCEEDED`
- `AGENT_TOKEN_BUDGET_EXCEEDED`
- `AGENT_COST_BUDGET_EXCEEDED`

发现异常时，先停止领取新的 Agent Run（保留历史数据），再回滚 Worker/Web 到同一版本。不要删除 `agent_runs` 或 `agent_steps`；重试依赖历史血缘和审计记录。
