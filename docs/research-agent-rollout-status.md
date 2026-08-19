# Research Agent Rollout Status

更新时间：2026-08-19

## 当前状态

- 目标 workspace：`kingdo` 的研究工作区（workspace id `28`）
- 实验：`research-agent-shadow-v1`
- 实验 public id：`exp_6a5746146c9c4c2bbccd5112fe4f58d4`
- workflow：`batch_research`
- variant：`shadow`，权重 `100`
- Controller mode：`shadow`
- 允许模板：`targeted_research`
- 动态任务额度：`2`
- `active` 质量门槛：failure `<= 10%`、policy reject `<= 60%`、tool match `>= 80%`、template match `>= 80%`、report gate 必须通过

## 影响范围

该实验只影响 workspace 28 的后续 `batch_research` 运行。Controller 会读取任务状态并
记录决策，但 shadow 模式不会让模型改变实际任务选择；Harness 仍按原有 DAG 和硬门槛
执行。远程数据库已应用 reasoning 与 trajectory migrations。

## 下一步观察

收集至少 3 个完整运行后检查 trajectory summary：

1. Controller failure、policy reject、tool match、template match。
2. 动态任务提议是否触及额度，是否出现重复或无效证据检索。
3. report gate、恢复、人工输入和最终报告契约是否全部通过。

只有这些样本通过 rollout resolver，才把该 variant 的 `agentControllerMode` 改为
`active`。发现异常时将实验状态改为 `paused`，不删除 reasoning 或 trajectory 记录。
