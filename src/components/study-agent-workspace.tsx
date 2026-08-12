import {
  BarChart3,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  FileCheck2,
  FileText,
  Link2,
  Menu,
  Share2,
  Sparkles,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { StudyAgentControls } from "@/components/study-agent-controls";
import { StudyDetailActions } from "@/components/study-detail-actions";
import { StudyReportPreview } from "@/components/study-report-preview";
import { StudyRunActions } from "@/components/study-run-actions";
import type { Viewer } from "@/lib/auth";
import { getOpenAIProviderStatus } from "@/lib/openai-provider";
import type { StudyDetail } from "@/lib/studies";
import { formatDuration, formatTokens, methodLabels, studyTypeLabels } from "@/lib/study-display";

type OpenAIProviderStatus = ReturnType<typeof getOpenAIProviderStatus>;

function ToolCall({
  name,
  status = "done",
  children,
}: {
  name: string;
  status?: "done" | "active" | "waiting" | "failed";
  children?: React.ReactNode;
}) {
  return (
    <details className={`agent-tool-call tool-${status}`} open={status === "active" || status === "failed"}>
      <summary><ChevronRight size={15} /><span>exec</span><strong>{name}</strong>{children ? <small>查看过程</small> : null}</summary>
      {children ? <div className="agent-tool-body">{children}</div> : null}
    </details>
  );
}

function PlanningTrace({ study }: { study: StudyDetail }) {
  return (
    <>
      <article className="agent-message agent-user-message">
        <span className="agent-avatar"><UserRound size={16} /></span>
        <div><strong>您</strong><p>{study.brief}</p></div>
      </article>
      <article className="agent-message">
        <span className="agent-avatar agent-avatar-ai"><Bot size={17} /></span>
        <div className="agent-message-content">
          <strong>atypica.AI</strong>
          <p>我已分析这个研究需求，并把目标、范围、方法与执行约束整理成一份可确认的计划。</p>
          <p>当前研究将围绕以下问题展开：</p>
          <ul>
            <li>理解用户的真实决策动机与关键阻力</li>
            <li>收集可核查的公开资料并形成证据链</li>
            <li>把研究发现转化为可执行的业务建议</li>
          </ul>
          <ToolCall name="analyzeBrief">
            <dl className="agent-tool-fields">
              <div><dt>研究类型</dt><dd>{studyTypeLabels[study.studyType] ?? study.studyType}</dd></div>
              <div><dt>框架</dt><dd>{study.plan.framework}</dd></div>
              <div><dt>目标受众</dt><dd>{study.plan.personaFilters.audience}</dd></div>
              <div><dt>信息来源</dt><dd>{study.plan.personaFilters.source}</dd></div>
            </dl>
          </ToolCall>
          <ToolCall name="makeStudyPlan">
            <section className="agent-plan-card">
              <header><div><span>研究计划</span><h2>{study.title}</h2></div><FileText size={20} /></header>
              <div className="agent-plan-grid">
                <section><h3>研究目标</h3><p>{study.plan.rationale}</p></section>
                <section><h3>研究方法</h3><p>{study.plan.methods.map((method) => methodLabels[method]).join(" + ") || "公开资料综合"}</p></section>
                <section><h3>预计周期</h3><p>{formatDuration(study.plan.estimatedDurationMinutes)}</p></section>
                <section><h3>预计用量</h3><p>{formatTokens(study.plan.estimatedTokens)} Tokens</p></section>
              </div>
              {study.plan.status === "confirmed" ? <div className="agent-plan-confirmed"><Check size={15} />研究计划已确认，执行记录已锁定</div> : <StudyDetailActions publicId={study.publicId} />}
            </section>
          </ToolCall>
        </div>
      </article>
    </>
  );
}

function ExecutionTrace({ study, provider }: { study: StudyDetail; provider: OpenAIProviderStatus }) {
  if (study.plan.status !== "confirmed") return null;

  const active = study.runStatus === "queued" || study.runStatus === "running";
  const failed = study.runStatus === "failed";

  return (
    <article className="agent-message agent-execution-message">
      <span className="agent-avatar agent-avatar-ai"><Sparkles size={17} /></span>
      <div className="agent-message-content">
        <strong>研究执行</strong>
        <p>计划已锁定。系统将只保留真实发生的模型调用、公开网页检索、错误与报告生成记录。</p>
        <ToolCall name="webResearch" status={failed ? "failed" : active ? "active" : "done"}>
          <dl className="agent-tool-fields">
            <div><dt>provider</dt><dd>{study.runProvider ?? "openai"}</dd></div>
            <div><dt>model</dt><dd>{study.runModel ?? provider.researchModel}</dd></div>
            <div><dt>status</dt><dd>{study.runStatus ?? "awaiting_provider"}</dd></div>
            {study.runError ? <div><dt>error</dt><dd>{study.runError}</dd></div> : null}
          </dl>
          <p className="agent-tool-message">
            {study.report
              ? `公开网页研究已完成，已保留 ${study.report.citations.length} 个可核查来源。`
              : active
                ? "正在检索、核查并综合公开资料，完成后会生成报告。"
                : failed
                  ? "执行未完成，错误已经写入运行记录，可以修复配置后重新启动。"
                  : "研究执行尚未开始。"}
          </p>
        </ToolCall>
        {study.report ? <ToolCall name="generateReport"><p className="agent-tool-message">报告已生成并保存到当前研究项目。</p></ToolCall> : null}
        {!study.report && !active ? <StudyRunActions publicId={study.publicId} configured={provider.configured} retry={failed} /> : null}
      </div>
    </article>
  );
}

function ResearchOutput({ study }: { study: StudyDetail }) {
  if (!study.report) return null;

  return (
    <section className="agent-research-output" id="research-output">
      <p className="agent-complete"><Check size={16} />研究已完成。</p>
      <h2>{study.report.title}</h2>
      <p>{study.report.content.executiveSummary}</p>
      <h3>核心发现</h3>
      <ol>{study.report.content.findings.slice(0, 3).map((finding) => <li key={finding.title}><strong>{finding.title}：</strong>{finding.insight}</li>)}</ol>
      <div className="agent-panel-summary">
        <span className="agent-panel-avatars"><i /><i /><i /><i /></span>
        <div><strong>公开资料研究与综合分析</strong><p>{study.report.citations.length} 个来源，{study.report.content.findings.length} 项洞察，{study.report.content.recommendations.length} 条行动建议</p></div>
      </div>
      <div className="agent-output-title"><span />研究产出</div>
      <button type="button" className="agent-podcast" disabled><span><FileCheck2 size={19} /></span>生成播客，聆听研究成果的深度解读</button>
    </section>
  );
}

export function StudyAgentWorkspace({
  study,
  viewer,
  provider,
}: {
  study: StudyDetail;
  viewer: Viewer;
  provider: OpenAIProviderStatus;
}) {
  const confirmed = study.plan.status === "confirmed";
  const completedSteps = study.report ? 4 : confirmed ? 2 : 1;
  const outputCount = study.report ? 1 : 0;

  return (
    <main className="agent-workspace-shell">
      <section className="agent-conversation-pane">
        <header className="agent-workspace-header">
          <Link href="/newstudy" className="agent-wordmark">atypica.AI</Link>
          <nav aria-label="研究工具">
            <button type="button" disabled title="统计面板后续开放"><BarChart3 size={17} />Nerd Stats</button>
            <button type="button" disabled title="回放分享后续开放"><Share2 size={17} />分享回放</button>
            <span className="agent-token-balance"><Link2 size={15} />{Math.round(viewer.tokenBalance / 1000)}k</span>
            <button type="button" disabled aria-label="帮助"><CircleHelp size={19} /></button>
            <button type="button" disabled aria-label="菜单"><Menu size={22} /></button>
          </nav>
        </header>
        <div className="agent-conversation-scroll" id="agent-progress">
          <h1>{study.title}</h1>
          <PlanningTrace study={study} />
          <ExecutionTrace study={study} provider={provider} />
          <ResearchOutput study={study} />
          {!study.report ? <div className="agent-stream-spacer" /> : null}
        </div>
        <StudyAgentControls completedSteps={completedSteps} totalSteps={4} outputCount={outputCount} />
      </section>
      <StudyReportPreview study={study} />
    </main>
  );
}
