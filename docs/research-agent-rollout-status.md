# Research Agent Rollout Status

更新时间：2026-08-21

## 当前状态

- 目标 workspace：`kingdo` 的研究工作区（workspace id `28`）
- 实验：`research-agent-shadow-v1`
- 实验 public id：`exp_6a5746146c9c4c2bbccd5112fe4f58d4`
- workflow：`batch_research`
- variant：`shadow`，权重 `100`
- Controller mode：`shadow`
- 允许模板：`targeted_research`
- 动态任务额度：`2`
- 生产 worker rollout 样本：`1`（run `38`，`completed`，由 `study_job_queue` worker 执行）
- 本地 Harness probe：历史 run `37` 已完成，但创建时未写入 `executionSource` 字段，因此当前 CLI 不将其计入 probe 统计；它不计入正式晋级样本。
- run `38` trajectory：5 次 Controller 决策，Controller failure `0`，policy reject `0`，tool match `100%`，template match `100%`，report gate 通过，动态任务 `0`。
- 最终报告：评审 `revise`，已执行修订并定稿（评分 `68`）
- `active` 质量门槛：failure `<= 10%`、policy reject `<= 60%`、tool match `>= 80%`、template match `>= 80%`、report gate 必须通过

## Provider 验证

- 报告阶段已切换为 `deepseek/deepseek-v4-pro`，report + judge smoke 已通过。
- yundu 兼容性探针已覆盖 `sol`、`sol-3.0`、`sol-3`、`gpt-5.6-terra` 和 `gpt-4o-mini`。
- 2026-08-21 从当前环境访问 `https://yundu.lat/v1` 时，`/models` 与全部 chat-completions
  请求均在网络层超时/不可达，没有返回 HTTP 状态；因此当前证据不足以判断 yundu 是否只支持
  `sol`，端点恢复后运行 `pnpm probe:yundu-models` 再确认。

## 影响范围

该实验只影响 workspace 28 的后续 `batch_research` 运行。Controller 会读取任务状态并
记录决策，但 shadow 模式不会让模型改变实际任务选择；Harness 仍按原有 DAG 和硬门槛
执行。远程数据库已应用 reasoning 与 trajectory migrations。

## 下一步观察

还需通过正式 `study_job_queue` worker 再收集至少 2 个同条件下的完整运行后检查 trajectory summary（当前 `1/3`）。CLI 和管理接口只统计 `executionSource=worker` 的记录；本地 Harness probe 仅用于开发验证：

1. Controller failure、policy reject、tool match、template match。
2. 动态任务提议是否触及额度，是否出现重复或无效证据检索。
3. report gate、恢复、人工输入和最终报告契约是否全部通过。

只有这些样本通过 rollout resolver，才把该 variant 的 `agentControllerMode` 改为
`active`。发现异常时将实验状态改为 `paused`，不删除 reasoning 或 trajectory 记录。
