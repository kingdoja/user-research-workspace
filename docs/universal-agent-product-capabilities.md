# Universal Agent 产品能力执行设计

日期：2026-08-19

## 结论

截图中的“模型返回的内容无法解析”是 `Universal Agent` 的结构化动作协议失败。它不是 Persona、访谈或报告服务本身不可用，而是当前模型响应没有通过 `universal_agent_turn` schema，旧实现没有修复重试，直接把整轮标记为失败。

更重要的产品缺口是：旧 Agent 只认识工作区中手动绑定的外部 Skill。网站已有的 AI Persona、AI 访谈、研究报告 API 没有进入 Agent 的工具目录，因此模型即使理解“创建 Persona / 发起访谈 / 做研究”，也没有合法的动作可以调用。

## 已实现

`src/lib/universal-agent-product-tools.ts` 注册了受治理的原生工具：

- `persona.list`：读取当前工作区 Persona。
- `persona.create`：创建结构化 Persona。
- `interview.create`：创建访谈项目；选择 AI Persona 时自动排队生成。
- `research.create`：创建研究并进入澄清/计划阶段。
- `research.run_confirmed`：只运行已经由用户确认并锁定的研究计划。
- `report.read`：读取当前工作区研究状态和已生成报告。

这些工具直接调用现有领域服务，不通过 HTTP 自调用，因此不会丢失当前用户和工作区权限。所有输入在执行前再次经过 Zod 校验；有副作用的工具必须勾选本轮执行确认，执行记录仍写入 `agent_steps`。

研究报告不能被 Agent 绕过确认直接生成。正确的路径是：创建研究 -> 用户完成澄清并确认计划 -> Agent 调用 `research.run_confirmed` -> Harness 执行证据、Persona、访谈和报告门槛 -> Agent 调用 `report.read`。

## 协议修复

Universal Agent 动作增加 `execute_product_tool` 和 `productToolName`。DeepSeek 或其他 OpenAI-compatible 网关第一次返回非 JSON/不符合 schema 时，服务端会发送一次只允许 JSON 的修复请求；修复结果仍必须通过同一 Zod schema，不能把任意文本当作成功。

## 为什么先写文档但不等待文档

文档用于固定能力边界、确认门槛和安全责任；执行代码必须同步实现，否则文档只是愿望清单。本次采用“契约与实现同提交”的方式：先定义工具输入/输出与禁止事项，再接入现有服务并进行类型检查。

## 后续验收

1. Agent 能在提示上下文中看到内置产品能力目录。
2. `persona.create`、`interview.create`、`research.create` 可返回真实公共 ID 和页面地址。
3. 未确认研究调用 `research.run_confirmed` 时返回 `plan_not_confirmed`，不创建运行任务。
4. 已生成报告可由 `report.read` 读回，跨工作区访问返回不存在。
5. 网关返回 Markdown 或残缺 JSON 时，修复成功则继续，修复仍失败才显示协议错误。
6. 所有动作均能在 Agent 运行记录中回放，且不展示隐藏思维链。

