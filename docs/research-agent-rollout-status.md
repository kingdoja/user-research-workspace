# Research Agent Rollout Status

更新时间：2026-08-22

## 当前状态

- 目标 workspace：`kingdo` 的研究工作区（workspace id `28`）
- 实验：`research-agent-shadow-v1`
- 实验 public id：`exp_6a5746146c9c4c2bbccd5112fe4f58d4`
- workflow：`batch_research`
- variant：`shadow`，权重 `100`
- Controller mode：`active`（仅 workspace 28 的受控 canary；不扩大生产流量）
- 允许模板：`targeted_research`
- 动态任务额度：`4`
- 生产 worker rollout 样本：`10`（shadow 4 条、active 6 条，均 `completed`，由 `study_job_queue` worker 执行）
- 本地 Harness probe：历史 run `37` 已完成，但创建时未写入 `executionSource` 字段，因此当前 CLI 不将其计入 probe 统计；它不计入正式晋级样本。
- run `38` trajectory：5 次 Controller 决策，Controller failure `0`，policy reject `0`，tool match `100%`，template match `100%`，report gate 通过，动态任务 `0`。
- run `40` trajectory：10 次 Controller 决策，Controller failure `0`，policy reject `0`，tool match `100%`，template match `100%`，report gate 通过，动态任务 `0`。
- run `41` trajectory：11 次 Controller 决策，Controller failure `0`，policy reject `0`，tool match `100%`，template match `100%`，report gate 通过，动态任务 `0`。
- active canary run `42`：`completed`，`controller_mode=active`，13 次 Controller 决策，Controller failure `0`，policy reject `0`，tool match `100%`，template match `100%`，report gate 通过，动态任务 `0`。权重仍为 `100`，未扩大模板或动态任务范围。
- active canary run `43`：`completed`，但出现 3 次 Controller 协议失败（空 `replan` 被拒绝后回退确定性 DAG），Controller failure rate `60%`、policy reject rate `50%`，未创建动态任务；随后已将 variant 回滚到 `shadow`。该 run 的后续 replan 还因报告 gate 已关闭被拒绝，说明需要在报告任务仍 pending 时触发扩展，并禁止依赖 `report`/`report_review`/`final_report`。
- run `44`：resolver 当时将请求降级为 `shadow`；模型在报告前正确提出了 `targeted_research`，但 shadow 按设计忽略，未计入 active 动态扩展验证。
- active canary run `45`：协议修复后无 Controller failure，但第一次空 `replan` 被确定性回退为执行 report，后续正确 replan 因 gate 已关闭被拒绝；动态任务仍为 `0`，随后回滚到 `shadow`。
- active canary run `46`：语义修复后成功执行 2 次 `agent.replan.accepted`，创建 2 个 `origin=dynamic` 任务（generation `1/2`），第一个完成，第二个因动态额度用尽进入 `waiting_input`；每个任务均关联 `reasoning_decision_id`。该 run 尚未完成报告 evaluation，因此保留为动态扩展链路验证，不计入 active 质量通过样本。
- active canary run `48`：将 `maxDynamicTasks` 从 `2` 放宽到 `4` 后，成功执行 1 次 `agent.replan.accepted`，创建 4 个动态任务并完成第一个；后续因公开证据链接不足进入 `waiting_input`。额度验证通过，但报告闭环未完成，已回滚到 `shadow`。
- active canary run `50`：当前版本唯一 worker 执行并完成完整闭环。Controller mode 为 `active`，16 次决策全部完成，Controller failure `0`，tool match `100%`，template match `100%`；接受 1 次 replan，创建并完成 4 个动态 `targeted_research` 任务，`reportGatePassed=true`，随后完成 `report`、`report_review` 和 `final_report`。出现 2 次 policy reject（其中 1 次为无 ready task 的输入动作），未触发人工介入。该样本证明动态扩展到最终报告的 mutation/执行链路有效，但 active 目前只有 1 条连续通过样本，继续保持受控 canary。
- active canary run `51`：完整报告闭环完成，13 次决策，Controller failure `0`、policy reject `0`、tool/template match `100%`、report gate 通过，动态任务 `0`。作为无扩展基线样本通过质量门槛。
- active canary run `52`：完整报告闭环完成，6 次决策，Controller failure `0`、policy reject `0`、tool/template match `100%`、report gate 通过，动态任务 `0`。作为第二条独立基线样本通过质量门槛。
- run `49` 未计入 active 评估：被旧常驻 worker 抢占，出现旧 provider JSON schema 不兼容和旧进程 MinIO 连接错误；当前 MinIO health 已恢复 `200`。后续 active canary 必须先确保只有当前版本 worker 持有队列 lease。
- run `39` 曾因同一 connector audit 返回重复 canonical URL 触发唯一约束失败；已在 source connector audit 物化前增加确定性去重，并由 run `40` 验证修复。该失败 run 不计入成功质量样本，但保留作为稳定性事件。
- 最终报告：评审 `revise`，已执行修订并定稿（评分 `68`）
- `active` 质量门槛：failure `<= 10%`、policy reject `<= 60%`、tool match `>= 80%`、template match `>= 80%`、report gate 必须通过

## Provider 验证

- 报告与 judge 阶段按部署环境通过通用 OpenAI-compatible Provider 路由；生产切换为
  `yundu/gpt-5.6-terra`，report + judge smoke 已通过。
- yundu 兼容性探针已覆盖生产使用的 `gpt-5.6-terra` 以及网关公开的其它候选模型。
- 2026-09-18 已从当前环境验证 `https://yundu.lol/v1`：`/models` 返回可用模型，
  `gpt-5.6-terra` 的 chat-completions 与严格 JSON Schema 请求均返回 200；发布时使用
  `pnpm probe:yundu-models` 复核网关模型清单。

## 影响范围

该实验只影响 workspace 28 的后续 `batch_research` 运行。Controller 会读取任务状态并
记录决策，但 shadow 模式不会让模型改变实际任务选择；Harness 仍按原有 DAG 和硬门槛
执行。远程数据库已应用 reasoning 与 trajectory migrations。

## 下一步观察

正式 shadow 样本门槛已满足（`4/4`），active 最近 3 条生产 worker 样本（`50`、`51`、`52`）连续通过质量门槛，动态扩展链路、额度 `4` 以及“动态任务完成后进入 report/final_report”的完整闭环均已验证。当前可将该 variant 视为受控 active 晋级，但仍保持权重 `100`、模板白名单 `targeted_research` 和动态任务额度 `4`，不扩大生产流量、不开放新模板。公开资料任务已改为自主检索，targeted research 允许单个可核查来源完成，不再因缺少用户 URL 自动暂停。下一阶段转入 active 运行监控：继续确保只有当前版本 worker 持有 lease，按每个 run 复核 failure、policy reject、tool/template match、report gate、动态任务额度和决策延迟，异常立即回滚到 `shadow`。CLI 和管理接口只统计 `executionSource=worker` 的记录；本地 Harness probe 仅用于开发验证：

1. Controller failure、policy reject、tool match、template match。
2. 动态任务提议是否触及额度，是否出现重复或无效证据检索。
3. report gate、恢复、人工输入和最终报告契约是否全部通过。

只有这些样本通过 rollout resolver，才把该 variant 的 `agentControllerMode` 改为
`active`。发现异常时将实验状态改为 `paused`，不删除 reasoning 或 trajectory 记录。
