# Hermes 类 Harness 架构决策

日期：2026-08-19

## 结论

本项目需要继续建设 Harness，但不需要引入一个新的 Hermes/Hermes-like 运行时，也不建议现在 fork 开源项目进行整体二次开发。

当前推荐架构是：

```text
模型 Agent Controller
        -> typed action
现有 Postgres Harness
        -> policy / budget / lease / retry / checkpoint / audit
Skill、产品工具、Sandbox、Connector
        -> 结构化结果和事件流
```

这里的 Harness 是执行治理层，不是某个产品名。仓库已经具备研究 Harness、Universal Agent 循环、版本化 Skill、租约队列、恢复、Sandbox 和 SSE 事件流。再引入一套 Hermes 状态模型会产生两套任务、会话、记忆、权限和恢复逻辑。

## 为什么不直接二次开发开源 Hermes

1. **状态模型不兼容**：本项目的事实来源是 Postgres 中的 `study_runs`、`study_tasks`、`agent_runs`、checkpoint 和事件表；通用 Agent 框架通常有自己的 session、trace 和状态持久化。
2. **安全边界不同**：Persona、访谈、研究和报告有工作区权限、用户确认、证据和报告 gate，不能由通用 Agent loop 绕过。
3. **执行语义不同**：现有 worker 需要租约、幂等、重试、取消和断点恢复；替换 loop 不会自动解决这些生产问题。
4. **迁移收益不确定**：Hermes 类项目适合借鉴工具协议、上下文压缩、记忆和多步规划，但不适合作为现有业务运行时的直接替换。

因此采用“借鉴接口和局部组件，保留本项目 Harness”为默认策略。

## 当前能力与缺口

已有能力：

- Agent Controller 每轮提出一个经过 schema 校验的动作。
- 原生产品工具：Persona、访谈、研究创建、确认运行、报告读取。
- Skill 版本绑定、能力授权、Sandbox 执行。
- Worker lease、重试、取消、checkpoint 和定向恢复。
- `agent_steps` / SSE 事件审计和断线续传。
- 研究 Harness 的证据、引用、报告和用户确认门槛。

继续需要补强的 Harness 能力：

- 每个 Agent Run 的 token、时间和工具调用预算。
- 工具输入/输出摘要大小限制，避免大报告污染上下文和 SSE。
- 统一的 capability registry：版本、权限、风险等级、输入输出 schema。
- 工具超时、幂等键、重试分类和外部副作用补偿策略。
- 运行回放、轨迹评估、失败步骤重试和 Web/Worker 版本健康检查。
- 需要长期记忆时，增加带来源、用途和保留策略的 memory service；不能把 checkpoint 自动当长期记忆。

## 何时可以引入开源组件

可以采用局部依赖或独立服务，但必须满足以下条件：

- 不接管本项目的数据库事实来源和权限判断。
- 能通过现有 capability/Skill gateway 调用工具。
- 能把 trace、tool call、checkpoint 和错误映射回现有事件模型。
- 支持明确的 license、供应链扫描、版本锁定和回滚。
- 先在 shadow 或离线评估中验证，再按 workspace 灰度。

推荐的引入顺序是：先实现本项目缺口；再评估单独的上下文压缩、记忆检索、浏览器/电脑执行器；最后才评估完整 Agent SDK。完整 SDK 只有在现有 Harness 无法满足恢复、观测或多 Agent 编排时才值得引入。

## 后续执行顺序

1. 先同步部署 Web 和 Worker，确认 Worker 使用 `universal-agent-v2-product-tools`。
2. 完成 Universal Agent 的预算、输出摘要限制、失败步骤重试和版本健康检查。
3. 对 `persona.list/create`、`interview.create`、`research.create/run_confirmed`、`report.read` 做真实账号的最小验收。
4. 在 `shadow` 模式评估动态研究 Controller 的成功率、成本、恢复和报告 gate，再逐 workspace 灰度 `active`。
5. 只有出现明确的能力缺口，才对某个开源组件做隔离 PoC；不直接 fork 并替换生产 Harness。

## 验收标准

一次运行必须能够追溯：用户目标、模型动作、能力版本、参数摘要、策略拒绝原因、工具结果、预算消耗、checkpoint 和最终报告 gate。模型可以决定下一步，但不能直接写数据库、提升权限、跳过确认或展示隐藏推理。

