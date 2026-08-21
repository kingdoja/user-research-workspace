import { notFound } from "next/navigation";
import { connection } from "next/server";
import { UniversalAgentWorkspace } from "@/components/universal-agent-workspace";
import type { UniversalAgentWorkspace as AgentWorkspaceData } from "@/lib/universal-agent";

export const dynamic = "force-dynamic";

export default async function UniversalAgentQaPage() {
  await connection();
  const environment = process.env;
  if (environment.ENABLE_QA_ROUTES !== "1") notFound();
  const workspace: AgentWorkspaceData = {
    provider: {
      stage: "reasoning",
      configured: true,
      providerName: "deepseek",
      model: "deepseek-v4-pro",
      protocol: "chat_completions",
      requiredVariable: "DEEPSEEK_API_KEY",
    },
    threads: [{
      publicId: "agt_qa_product_tools",
      title: "电动车用户研究",
      status: "active",
      updatedAt: new Date().toISOString(),
      lastMessage: "已创建访谈并开始生成会话。",
      lastRunStatus: "completed",
    }],
    selectedThreadPublicId: "agt_qa_product_tools",
    messages: [
      {
        publicId: "agm_qa_user",
        role: "user",
        content: "基于现有 AI Persona 创建一轮电动车用户访谈，并整理成研究报告。",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
      {
        publicId: "agm_qa_agent",
        role: "assistant",
        content: "已创建访谈项目。研究报告需要先完成研究澄清并由你确认计划，然后才能启动生成。",
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    ],
    files: [{
      publicId: "agf_qa_interview",
      path: "deliverables/interview-plan.md",
      mediaType: "text/markdown",
      version: 1,
      byteSize: 1840,
      updatedAt: new Date().toISOString(),
    }],
    skills: [{
      publicId: "skl_qa_analysis",
      slug: "interview-analysis",
      name: "访谈分析",
      description: "分析访谈记录并提炼主题。",
      version: 2,
      executorType: "sandbox",
      packageFormat: "atypica.skill/v2",
    }],
    productTools: [
      { name: "persona.list", title: "查询 AI Persona", description: "列出当前工作区 Persona。", mutates: false },
      { name: "persona.create", title: "创建 AI Persona", description: "创建结构化 Persona。", mutates: true },
      { name: "interview.create", title: "创建并运行 AI 访谈", description: "创建访谈项目。", mutates: true },
      { name: "research.create", title: "创建研究与报告任务", description: "创建研究项目。", mutates: true },
      { name: "research.run_confirmed", title: "运行已确认研究", description: "运行已确认计划。", mutates: true },
      { name: "report.read", title: "读取研究报告", description: "读取已生成报告。", mutates: false },
    ],
    recentRuns: [{
      publicId: "agr_qa_completed",
      threadPublicId: "agt_qa_product_tools",
      status: "completed",
      stepsUsed: 4,
      maxSteps: 6,
      toolCallsUsed: 3,
      maxToolCalls: 6,
      productToolCallsUsed: 2,
      maxProductToolCalls: 4,
      externalToolCallsUsed: 1,
      maxExternalToolCalls: 2,
      tokensUsed: 8_240,
      tokenBudget: 100_000,
      costMicrosUsed: 412,
      maxCostMicros: 1_000_000,
      externalExecutionAllowed: true,
      startedAt: new Date().toISOString(),
    }],
  };
  return <UniversalAgentWorkspace initialWorkspace={workspace} canRun />;
}
