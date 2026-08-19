# Research Agent Rollout Runbook

本手册用于把研究 Agent 从实现验证推进到 workspace/strategy 灰度。生产执行内核
仍是 Postgres-backed Harness；Agent Controller 只提出动作，不能直接写 ledger。

## 1. 前置条件

- 已应用 `supabase/migrations/20260819010000_research_agent_reasoning.sql` 和
  `supabase/migrations/20260819020000_research_agent_trajectory.sql`。
- `research-agent-controller` 默认保持 `off`。
- 先准备一个可回滚的 strategy variant，不直接修改默认生产 variant。
- 数据库 smoke 只允许 localhost PostgreSQL。远程 Supabase 环境应使用部署流水线的
  migration 和受控测试 workspace，不要运行会删除数据库的 isolated smoke。

## 2. 推荐策略配置

先使用 shadow，并只开放一个模板：

```json
{
  "agentControllerMode": "shadow",
  "agentControllerAllowedTemplates": ["targeted_research"],
  "maxDynamicTasks": 2,
  "agentControllerShadowMinRuns": 3,
  "agentControllerMaxFailureRate": 0.1,
  "agentControllerMaxRejectRate": 0.6,
  "agentControllerMinCallToolMatchRate": 0.8,
  "agentControllerMinTemplateMatchRate": 0.8
}
```

`social_signal_scan` 只有在目标 workspace 已经配置来源能力、平台输入和审计展示后
再加入白名单。模板目录版本为 `research-agent-task-templates-v1`。

## 3. Shadow 验收

至少观察 3 个同 workspace/strategy 的完整运行，并检查：

- Controller failure rate <= 10%
- policy reject rate <= 60%
- call-tool match rate >= 80%
- template match rate >= 80%
- report gate 全部通过
- 动态任务数量没有持续触及额度上限
- `study_events` 中有完整的 action、拒绝原因、模板版本和 mutation 事件

可以用运行回放和比较页检查 trajectory summary；不要只看最终报告是否生成。

管理员也可以读取实验状态接口：

```text
GET /api/experiments/{experimentPublicId}/status
```

响应会返回每个 variant 的样本数、原始 trajectory 指标、允许模板和当前 quality gate
判断，便于在切换 `active` 前留下可复核记录。

命令行也可以从部署环境直接检查同一状态：

```bash
pnpm research-agent:rollout-status 28 research-agent-shadow-v1
```

退出前重点确认 `sampleCount`、`quality.passed` 和 `quality.reason`，不要仅根据实验
状态为 `active` 就认为 Controller 已经 active；实验 active 只表示 variant 可被分配，
实际 Controller mode 仍由 variant config 和 rollout resolver 决定。

## 4. Active 切换

只有 shadow 样本满足上述门槛后，才把同一个 strategy variant 改为：

```json
{
  "agentControllerMode": "active"
}
```

Harness 启动 run 时会再次读取最近 trajectory。如果样本不足或任一门槛失败，实际
模式会自动降级为 `shadow`，并在 `run.started` / `run.resumed` 记录 requested mode、
effective mode 和降级原因。

## 5. 回滚

出现 schema、预算、恢复、审计或报告契约异常时，将 strategy variant 改回
`agentControllerMode: "shadow"`；若需要立即停止 Controller，则改为 `off`。不要删除
trajectory 或 reasoning decision 记录，它们是回滚后的诊断依据。

## 6. 本地验证

纯逻辑验证：

```bash
pnpm smoke:research-agent-controller
```

本地 PostgreSQL 隔离验证：

```bash
LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres \
  pnpm smoke:isolated research-agent-trajectory
```

当前 workspace 的 `.env.local` 使用远程 Supabase pooler，因此不能把
`smoke:research-agent-trajectory` 直接指向该连接执行清理型测试。
