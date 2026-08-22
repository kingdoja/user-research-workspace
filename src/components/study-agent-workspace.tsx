import {
  BarChart3,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  FileCheck2,
  Files,
  FileText,
  GitCompareArrows,
  Link2,
  LoaderCircle,
  Menu,
  RotateCcw,
  Sparkles,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { StudyAgentControls, type StudyProgressItem } from "@/components/study-agent-controls";
import { ReportClaimEvidence } from "@/components/report-claim-evidence";
import {
  StudyAgentConsole,
  StudyArtifactConsoleProvider,
  StudyArtifactOpenButton,
} from "@/components/study-agent-console";
import { StudyClarificationForm } from "@/components/study-clarification-form";
import { StudyDetailActions } from "@/components/study-detail-actions";
import { StudyFollowupSuggestions } from "@/components/study-followup-suggestions";
import { StudyPanelOpenButton } from "@/components/study-panel-open-button";
import { StudyRunActions } from "@/components/study-run-actions";
import { StudyAutoRefresh } from "@/components/study-auto-refresh";
import { StudyReplayControls } from "@/components/study-replay-controls";
import { StudyShareControls } from "@/components/study-share-controls";
import { StudyTaskInputForm } from "@/components/study-task-input-form";
import { StructuredFollowupAnswer } from "@/components/structured-followup-answer";
import type { Viewer } from "@/lib/auth";
import { getOpenAIProviderStatus } from "@/lib/openai-provider";
import type { StudyDetail } from "@/lib/studies";
import { formatDuration, formatTokens, methodLabels, studyTypeLabels } from "@/lib/study-display";

type OpenAIProviderStatus = ReturnType<typeof getOpenAIProviderStatus>;
type StudyEvent = StudyDetail["events"][number];
type ProgressDefinition = StudyProgressItem & {
  toolName: string;
  startedTypes: string[];
  completedTypes: string[];
  activeSummary: string;
  completedSummary: string;
};

const progressDefinitions: Omit<ProgressDefinition, "status">[] = [
  { key: "trend", label: "跨品类趋势扫描——用户痛点与场景创新", toolName: "scoutCategoryTrends", startedTypes: ["trend.scan.started", "search.plan.completed"], completedTypes: ["trend.scan.completed"], activeSummary: "正在规划检索词并收集与用户痛点、使用场景相关的公开网页证据。", completedSummary: "已完成第一组公开网页证据的筛选和归档。" },
  { key: "upgrade", label: "跨品类趋势扫描——存量换购与品牌升级策略", toolName: "scanUpgradeStrategies", startedTypes: ["upgrade.scan.started"], completedTypes: ["upgrade.scan.completed"], activeSummary: "正在从已收集证据中分析换购触发因素、选择标准与品牌升级路径。", completedSummary: "已整理存量换购和品牌升级相关证据。" },
  { key: "policy", label: "行业深度研究——政策与市场背景", toolName: "deepIndustryResearch", startedTypes: ["policy.research.started"], completedTypes: ["policy.research.completed"], activeSummary: "正在核对政策、行业背景和市场约束，并标记需要复核的公开来源。", completedSummary: "已完成政策与行业背景研究。" },
  { key: "personas", label: "构建目标用户 Persona（6–8 个差异化画像）", toolName: "buildPersona", startedTypes: ["personas.generate.started"], completedTypes: ["personas.generated"], activeSummary: "正在依据 Brief 与公开证据生成差异化 AI 合成 Persona，不代表真人样本。", completedSummary: "已生成并标记 AI 合成 Persona。" },
  { key: "panel", label: "创建用户访谈 Panel", toolName: "createPanel", startedTypes: ["panel.create.started"], completedTypes: ["panel.created"], activeSummary: "正在把合成 Persona 编排为研究 Panel，并保留其差异化场景。", completedSummary: "已创建 AI 合成研究 Panel。" },
  { key: "interview-one", label: "深度访谈——决策路径（第一批）", toolName: "interviewChatBatchOne", startedTypes: ["interviews.batch1.started"], completedTypes: ["interviews.batch1.completed"], activeSummary: "正在模拟第一批 Persona 的换购触发、信息搜索、比较筛选和决策路径。", completedSummary: "第一批 AI 模拟访谈已完成。" },
  { key: "interview-two", label: "深度访谈——体验与焦虑（第二批）", toolName: "interviewChatBatchTwo", startedTypes: ["interviews.batch2.started"], completedTypes: ["interviews.batch2.completed"], activeSummary: "正在模拟第二批 Persona 的真实使用场景、关键焦虑与功能机会。", completedSummary: "第二批 AI 模拟访谈已完成。" },
  { key: "validation", label: "快速验证——创新方向适配性", toolName: "validateDirections", startedTypes: ["validation.started"], completedTypes: ["validation.completed"], activeSummary: "正在用公开证据和合成 Persona 对候选方向进行压力测试。", completedSummary: "候选创新方向的适配性验证已完成。" },
  { key: "report", label: "生成最终研究报告", toolName: "generateReport", startedTypes: ["report.synthesis.started"], completedTypes: ["report.generated", "report.completed"], activeSummary: "正在综合公开证据、模拟访谈、验证结果与研究局限，生成可审计报告。", completedSummary: "最终研究报告已生成。" },
];

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sourceList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const title = "title" in item && typeof item.title === "string" ? item.title : "公开来源";
    const url = "url" in item && typeof item.url === "string" ? item.url : "";
    return url ? [{ title, url }] : [];
  });
}

function directionList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !("title" in item) || typeof item.title !== "string") return [];
    const verdict = "verdict" in item && typeof item.verdict === "string" ? item.verdict : "";
    return [{ title: item.title, verdict }];
  });
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="agent-json-block">{JSON.stringify(value, null, 2)}</pre>;
}

function TracePayloadDetails({
  stepKey,
  payload,
  events,
}: {
  stepKey: string;
  payload: Record<string, unknown>;
  events: StudyEvent[];
}) {
  const queries = stepKey === "trend"
    ? stringList(events.find((event) => event.type === "search.plan.completed")?.payload.queries)
    : [];
  const sources = sourceList(payload.sources);
  const names = stringList(payload.names);
  const participants = stringList(payload.participants);
  const directions = directionList(payload.directions);
  const panelTitle = typeof payload.title === "string" ? payload.title : "";

  if (!queries.length && !sources.length && !names.length && !participants.length && !directions.length && !panelTitle) {
    return null;
  }

  return (
    <div className="agent-trace-details">
      {queries.length ? <section><h4>检索词</h4><div className="agent-trace-chips">{queries.map((query) => <span key={query}>{query}</span>)}</div></section> : null}
      {sources.length ? (
        <section>
          <h4>公开网页来源</h4>
          <ol className="agent-source-list">{sources.map((source) => {
            let domain = source.url;
            try {
              domain = new URL(source.url).hostname.replace(/^www\./, "");
            } catch {}
            return <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer"><strong>{source.title}</strong><small>{domain}</small></a></li>;
          })}</ol>
        </section>
      ) : null}
      {names.length ? <section><h4>AI 合成 Persona</h4><div className="agent-trace-chips">{names.map((name) => <span key={name}>{name}</span>)}</div></section> : null}
      {panelTitle ? <section><h4>Panel</h4><p>{panelTitle}</p></section> : null}
      {participants.length ? <section><h4>模拟访谈对象</h4><div className="agent-trace-chips">{participants.map((name) => <span key={name}>{name}</span>)}</div></section> : null}
      {directions.length ? <section><h4>验证方向</h4><ol className="agent-direction-list">{directions.map((direction) => <li key={direction.title}><span>{direction.title}</span>{direction.verdict ? <small>{direction.verdict}</small> : null}</li>)}</ol></section> : null}
    </div>
  );
}

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

function ArtifactResultCard({ artifact }: { artifact: StudyDetail["artifacts"][number] }) {
  const content = Array.isArray(artifact.content) ? {} : artifact.content;
  const count = Array.isArray(artifact.content)
    ? artifact.content.length
    : typeof content.count === "number"
    ? content.count
    : typeof content.matchCount === "number"
      ? content.matchCount
      : typeof content.participantCount === "number"
        ? content.participantCount
        : Array.isArray(content.personas)
          ? content.personas.length
          : Array.isArray(content.sources)
            ? content.sources.length
            : Array.isArray(content.messages)
              ? content.messages.length
              : null;
  const typeLabel: Record<string, string> = {
    research_plan: "研究计划",
    public_sources: "证据包",
    persona_search: "Persona 检索",
    persona_set: "Persona",
    panel: "Panel",
    synthetic_interviews_batch_1: "访谈记录",
    synthetic_interviews_batch_2: "访谈记录",
    direction_validation: "方向验证",
    discussion_transcript: "讨论记录",
    research_report: "研究报告",
  };
  return (
    <article className="agent-artifact-card">
      <span><Files size={17} /></span>
      <div><small>{typeLabel[artifact.type] ?? "研究产物"}{count !== null ? ` · ${count}` : ""}</small><strong>{artifact.title}</strong><p>已写入当前 Run，可回放并作为后续工具输入。</p></div>
      <StudyArtifactOpenButton artifactId={artifact.publicId} />
    </article>
  );
}

function PlanningTrace({ study }: { study: StudyDetail }) {
  const clarificationPending = study.clarification.status === "pending";
  const clarificationCompleted = study.clarification.status === "completed";
  const answerMap = new Map(study.clarification.answers.map((answer) => [answer.questionId, answer.selected]));

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
          <p className="agent-thought-label">计划解析 · 结构化输出</p>
          <p>{clarificationPending
            ? "这个 Brief 已经包含一个明确的研究主题，但业务决策、研究重点和目标人群仍会直接改变研究设计。我需要先确认这些关键边界。"
            : "我已分析研究需求和澄清答案，并把业务目标、范围、方法与执行约束整理成可确认的计划。"}</p>
          <ToolCall name="analyzeBrief">
            <dl className="agent-tool-fields">
              <div><dt>产品线</dt><dd>{study.productLine === "market_insight" ? "Market Insight" : "Research"}</dd></div>
              <div><dt>研究类型</dt><dd>{studyTypeLabels[study.studyType] ?? study.studyType}</dd></div>
              <div><dt>框架</dt><dd>{study.plan.framework}</dd></div>
              <div><dt>目标受众</dt><dd>{study.plan.personaFilters.audience}</dd></div>
              <div><dt>信息来源</dt><dd>{study.plan.personaFilters.source}</dd></div>
            </dl>
          </ToolCall>
          {clarificationPending ? (
            <ToolCall name="requestInteraction" status="active">
              <StudyClarificationForm publicId={study.publicId} questions={study.clarification.questions} />
            </ToolCall>
          ) : null}
          {clarificationCompleted ? (
            <ToolCall name="requestInteraction">
              <div className="agent-clarification-result">
                {study.clarification.questions.map((question) => (
                  <div key={question.id}><strong>{question.label}</strong><p>{(answerMap.get(question.id) ?? []).join("、")}</p></div>
                ))}
              </div>
            </ToolCall>
          ) : null}
          {!clarificationPending && study.intent ? (
            <ToolCall name="resolveIntentContract">
              <dl className="agent-tool-fields">
                <div><dt>Intent</dt><dd>v{study.intent.version} · {study.intent.lifecycleStatus}</dd></div>
                <div><dt>产品线</dt><dd>{study.intent.productLine === "market_insight" ? "Market Insight" : "Research"}</dd></div>
                <div><dt>Schema</dt><dd>{study.intent.schemaVersion}</dd></div>
                <div><dt>Hash</dt><dd title={study.intent.contentHash}>{study.intent.contentHash.slice(0, 12)}…</dd></div>
                <div><dt>Context purpose</dt><dd>{study.intent.context?.purpose ?? "intent_planning"}</dd></div>
                <div><dt>Context snapshot</dt><dd>{study.intent.context?.retrievalPublicId ?? "无命中"}</dd></div>
                <div><dt>Context 引用</dt><dd>{study.intent.context?.citationCount ?? 0} 条</dd></div>
                <div><dt>Policy 拒绝</dt><dd>{typeof study.intent.context?.policyDecision.deniedMemoryChunks === "number" ? study.intent.context.policyDecision.deniedMemoryChunks : 0} 条 Memory</dd></div>
                <div><dt>Prompt</dt><dd>{study.intent.promptVersion}</dd></div>
              </dl>
            </ToolCall>
          ) : null}
          {!clarificationPending ? <ToolCall name="makeStudyPlan">
            <section className="agent-plan-card">
              <header><div><span>研究计划</span><h2>{study.title}</h2></div><FileText size={20} /></header>
              <div className="agent-plan-grid">
                <section><h3>研究目标</h3><p>{study.plan.rationale}</p></section>
                <section><h3>研究方法</h3><p>{study.plan.methods.map((method) => methodLabels[method]).join(" + ") || "公开资料综合"}</p></section>
                <section><h3>预计周期</h3><p>{formatDuration(study.plan.estimatedDurationMinutes)}</p></section>
                <section><h3>预计用量</h3><p>{formatTokens(study.plan.estimatedTokens)} Tokens</p></section>
              </div>
              {study.plan.status === "confirmed" ? <div className="agent-plan-confirmed"><Check size={15} />Plan v{study.plan.version} 已确认 · {study.plan.contentHash ? `${study.plan.contentHash.slice(0, 10)}…` : "执行版本已锁定"}{study.workflow ? ` · Workflow v${study.workflow.version}` : ""}</div> : <StudyDetailActions publicId={study.publicId} />}
            </section>
          </ToolCall> : null}
        </div>
      </article>
    </>
  );
}

function ExecutionTrace({ study, provider }: { study: StudyDetail; provider: OpenAIProviderStatus }) {
  if (study.plan.status !== "confirmed") return null;

  const active = (study.runStatus === "queued" || study.runStatus === "running") && !study.runRecoverable;
  const failed = study.runStatus === "failed" || study.runRecoverable;
  const waitingInput = study.runStatus === "waiting_input";
  const autonomousRecovery = waitingInput && study.tasks.some((task) => (
    task.status === "waiting_input" && task.lastErrorCode === "PUBLIC_WEB_SOURCES_INSUFFICIENT"
  ));
  const events = study.events.filter((event) => !study.runId || event.runId === study.runId || event.runId === null);
  const steps = createProgressItems(study);
  const activeStep = steps.find((step) => step.status === "active");
  const latestEvent = events.at(-1);
  const tasksByKey = new Map(study.tasks.map((task) => [task.key, task]));
  const actionLabels: Record<string, string> = {
    continue: "继续固定 DAG",
    append_task: "追加受控任务",
    replan: "Agent 追加受控任务",
    refresh_context: "刷新受授权 Context",
    stop_expansion: "停止动态扩展",
    finish_run: "结束运行",
  };

  return (
    <article className="agent-message agent-execution-message">
      <span className="agent-avatar agent-avatar-ai"><Sparkles size={17} /></span>
      <div className="agent-message-content">
        <div className="agent-execution-heading">
          <strong>研究执行</strong>
          {study.runAttempt ? <span>第 {study.runAttempt} 次执行</span> : null}
        </div>
        {study.runId && study.tasks.length > 0 && study.runStatus === "completed" ? <StudyReplayControls runId={study.runId} stepCount={steps.length} /> : null}
        <div className="agent-runtime-contract">
          <strong>Governed Research Runtime</strong>
          <span>计划任务作为安全边界 · 动态动作写入可恢复 ledger</span>
        </div>
        <p>Controller 启用时选择下一步，Harness 校验工具、输入、依赖和预算后执行；未启用或失败时回退到确定性调度。模拟参与者不会被标记为真人样本。</p>
        {activeStep ? (
          <div className="agent-live-update" role="status" aria-live="polite">
            <span><LoaderCircle className="spin" size={14} />实时执行摘要</span>
            <p>{activeStep.activeSummary}</p>
            <small>{latestEvent ? `最近更新 ${new Date(latestEvent.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "正在启动研究任务"}</small>
          </div>
        ) : null}
        {active ? (
          <StudyAutoRefresh
            publicId={study.publicId}
            after={events.at(-1)?.id ?? "0"}
            initialEvents={events.slice(-20)}
          />
        ) : null}
        {study.runRecoverable ? (
          <div className="agent-interrupted-state" role="alert">
            <RotateCcw size={16} />
            <div><strong>上次执行已中断</strong><p>运行超过 10 分钟未更新。恢复会从最近 checkpoint 继续，已完成任务和 artifact 不会重复生成。</p></div>
          </div>
        ) : null}
        <section className="agent-execution-timeline" data-replay-run={study.runId ?? undefined}>
          {steps.map((step, index) => {
            const task = tasksByKey.get(step.key);
            const startedEvent = events.findLast((event) => step.startedTypes.includes(event.type));
            const completedEvent = events.findLast((event) => step.completedTypes.includes(event.type));
            const relatedEvent = completedEvent ?? startedEvent;
            const artifact = study.artifacts.findLast((item) => item.taskKey === step.key);
            const todoEvent = events.findLast((event) => event.type === "todo.updated" && event.payload.taskKey === step.key);
            const payload = task?.output && Object.keys(task.output).length ? task.output : relatedEvent?.payload ?? {};
            const startedAt = task?.startedAt ? new Date(task.startedAt) : startedEvent ? new Date(startedEvent.createdAt) : null;
            const completedAt = task?.finishedAt ? new Date(task.finishedAt) : completedEvent ? new Date(completedEvent.createdAt) : null;
            const elapsedSeconds = startedAt && completedAt ? Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 1000)) : null;
            const stepSummary = step.status === "done"
              ? step.completedSummary
              : step.status === "active"
                ? step.activeSummary
                : step.status === "failed"
                  ? "任务未完成，错误详情已记录在当前步骤。"
                  : "等待前序研究任务完成。";
            return <div className="agent-task-event" key={step.key}>
              <ToolCall name={step.toolName} status={step.status}>
                  <p className="agent-tool-message"><strong>{index + 1}. {step.label}</strong></p>
                  {task?.origin === "dynamic" ? <span className="agent-dynamic-task-badge">动态追加 · 第 {task.generation} 代</span> : null}
                  <p className="agent-step-summary">{stepSummary}</p>
                  <dl className="agent-tool-fields">
                    <div><dt>status</dt><dd>{step.status}</dd></div>
                    {startedAt ? <div><dt>started</dt><dd>{startedAt.toLocaleTimeString("zh-CN")}</dd></div> : null}
                    {completedAt ? <div><dt>completed</dt><dd>{completedAt.toLocaleTimeString("zh-CN")}</dd></div> : null}
                    {elapsedSeconds !== null ? <div><dt>duration</dt><dd>{elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`}</dd></div> : null}
                    {typeof payload.sourceCount === "number" ? <div><dt>sources</dt><dd>{payload.sourceCount}</dd></div> : null}
                    {typeof payload.count === "number" ? <div><dt>personas</dt><dd>{payload.count}</dd></div> : null}
                    {typeof payload.participantCount === "number" ? <div><dt>participants</dt><dd>{payload.participantCount}</dd></div> : null}
                    {typeof payload.directionCount === "number" ? <div><dt>directions</dt><dd>{payload.directionCount}</dd></div> : null}
                    {typeof payload.citationCount === "number" ? <div><dt>sources</dt><dd>{payload.citationCount}</dd></div> : null}
                    {typeof payload.findingCount === "number" ? <div><dt>findings</dt><dd>{payload.findingCount}</dd></div> : null}
                    {typeof payload.recommendationCount === "number" ? <div><dt>recommendations</dt><dd>{payload.recommendationCount}</dd></div> : null}
                    {index === 0 ? <><div><dt>provider</dt><dd>{study.runProvider ?? provider.providerName}</dd></div><div><dt>model</dt><dd>{study.runModel ?? provider.researchModel}</dd></div></> : null}
                    {task && task.attempt > 0 ? <div><dt>attempt</dt><dd>{task.attempt}</dd></div> : null}
                    {task?.nextAttemptAt ? <div><dt>retry</dt><dd>将在 {new Date(task.nextAttemptAt).toLocaleTimeString("zh-CN")} 重试</dd></div> : null}
                    {task?.resumedAt ? <div><dt>resumed</dt><dd>第 {task.resumeCount} 次继续</dd></div> : null}
                    {step.status === "failed" && (task?.error ?? study.runError) ? <div><dt>error</dt><dd>{task?.error ?? study.runError}</dd></div> : null}
                  </dl>
                  <TracePayloadDetails stepKey={step.key} payload={payload} events={events} />
                  {task ? <div className="agent-tool-log">
                    <details><summary>args</summary><JsonBlock value={task.input} /></details>
                    <details><summary>result</summary><JsonBlock value={task.output} /></details>
                    <details open><summary>message</summary><p>{stepSummary}</p></details>
                  </div> : null}
                  {task?.attempts.length ? <details className="agent-task-attempts">
                    <summary>尝试记录 · {task.attempts.length} 次</summary>
                    <ol>{task.attempts.map((attempt) => <li key={attempt.publicId}>
                      <strong>#{attempt.attempt} · {attempt.status}</strong>
                      <span>{attempt.errorClass ?? "执行"}{attempt.errorCode ? ` · ${attempt.errorCode}` : ""}</span>
                      {attempt.error ? <small>{attempt.error}</small> : null}
                    </li>)}</ol>
                  </details> : null}
                  {task?.lastErrorCode === "PUBLIC_WEB_SOURCES_INSUFFICIENT"
                    ? <p className="agent-step-summary">系统会自动扩展检索并继续，不需要补充 URL。</p>
                    : task?.inputRequest
                      ? <StudyTaskInputForm studyPublicId={study.publicId} taskPublicId={task.publicId} request={task.inputRequest.request} />
                      : null}
              </ToolCall>
              {artifact ? <ArtifactResultCard artifact={artifact} /> : null}
              {todoEvent ? <ToolCall name="updateTodo" status="done" /> : null}
            </div>;
          })}
        </section>
        {study.reasoningDecisions.length ? (
          <details className="agent-reasoning-trace" open>
            <summary><ChevronRight size={15} /><strong>调度决策</strong><span>{study.reasoningDecisions.length} 次</span></summary>
            <ol>{study.reasoningDecisions.map((decision) => {
              const action = typeof decision.chosenAction.type === "string" ? decision.chosenAction.type : "continue";
              const coverage = typeof decision.metrics.coverage === "number" ? Math.round(decision.metrics.coverage * 100) : null;
              const conflict = typeof decision.metrics.conflict === "number" ? Math.round(decision.metrics.conflict * 100) : null;
              const novelty = typeof decision.metrics.novelty === "number" ? Math.round(decision.metrics.novelty * 100) : null;
              const tokenUsage = typeof decision.budget.tokenUsage === "number" ? decision.budget.tokenUsage : null;
              const tokenBudget = typeof decision.budget.tokenBudget === "number" ? decision.budget.tokenBudget : null;
              const selected = decision.candidates.find((candidate) => candidate.selected);
              return (
                <li key={decision.publicId}>
                  <header><span>#{decision.sequence + 1}</span><strong>{actionLabels[action] ?? action}</strong><time>{new Date(decision.createdAt).toLocaleTimeString("zh-CN")}</time></header>
                  <p>{decision.reason}</p>
                  <dl>
                    {coverage !== null ? <div><dt>coverage</dt><dd>{coverage}%</dd></div> : null}
                    {conflict !== null ? <div><dt>conflict</dt><dd>{conflict}%</dd></div> : null}
                    {novelty !== null ? <div><dt>novelty</dt><dd>{novelty}%</dd></div> : null}
                    {tokenUsage !== null && tokenBudget !== null ? <div><dt>budget</dt><dd>{formatTokens(tokenUsage)} / {formatTokens(tokenBudget)}</dd></div> : null}
                    {decision.contextRefresh ? <div><dt>context</dt><dd>{decision.contextRefresh.citationCount} 条 · {decision.contextRefresh.triggerType}</dd></div> : null}
                  </dl>
                  {decision.contextRefresh ? <small>快照 {decision.contextRefresh.retrievalPublicId} · {decision.contextRefresh.targetTaskKey ?? "下一任务"}</small> : null}
                  {selected ? <small>policy {decision.policyVersion} · score {selected.score.toFixed(2)}</small> : null}
                </li>
              );
            })}</ol>
          </details>
        ) : null}
        {study.runHistory.length > 0 ? (
          <details className="agent-run-history" open={study.runHistory.length > 1}>
            <summary><ChevronRight size={15} /><strong>执行历史</strong><span>{study.runHistory.length} 次</span></summary>
            {study.runHistory.length > 1 ? <Link className="agent-run-compare-link" href={`/study/${study.publicId}/compare`}><GitCompareArrows size={14} />对比 Run 回放</Link> : null}
            <ol>{study.runHistory.toReversed().map((run) => {
              const statusLabel = run.status === "completed" ? "已完成" : run.status === "failed" ? "失败" : run.status === "waiting_input" ? "等待输入" : run.status === "running" ? "执行中" : "排队中";
              const started = new Date(run.startedAt ?? run.createdAt);
              const ended = run.finishedAt ? new Date(run.finishedAt) : null;
              const duration = ended ? Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000)) : null;
              return (
                <li key={run.id} className={`run-history-${run.status}`}>
                  <span className="run-history-marker" />
                  <div><strong>第 {run.attempt} 次执行 · {statusLabel}</strong><p>{run.completedSteps}/{run.totalSteps} 个步骤 · {run.eventCount} 条事件{duration !== null ? ` · ${duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`}` : ""}</p>{run.error ? <small>{run.error}</small> : null}</div>
                  <time>{started.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
                </li>
              );
            })}</ol>
          </details>
        ) : null}
        {!study.report && !active && (!waitingInput || autonomousRecovery) ? (
          <StudyRunActions
            publicId={study.publicId}
            configured={provider.configured}
            retry={failed || autonomousRecovery}
            autonomousRecovery={autonomousRecovery}
          />
        ) : null}
      </div>
    </article>
  );
}

function ResearchOutput({ study }: { study: StudyDetail }) {
  if (!study.report) return null;
  const findingNodes = study.report.evidenceGraph?.nodes.filter((node) => node.nodeType === "finding") ?? [];

  return (
    <section className="agent-research-output" id="research-output">
      <p className="agent-complete"><Check size={16} />研究已完成。</p>
      <h2>{study.report.title}</h2>
      <p>{study.report.content.executiveSummary}</p>
      <h3>核心发现</h3>
      <ol>{study.report.content.findings.slice(0, 3).map((finding, index) => <li key={finding.title}><strong>{finding.title}：</strong>{finding.insight}<ReportClaimEvidence claim={findingNodes[index]?.claim ?? null} /></li>)}</ol>
      <div className="agent-panel-summary">
        <span className="agent-panel-avatars"><i /><i /><i /><i /></span>
        <div><strong>{study.panel ? `${study.panel.title} · AI 合成 Panel` : "公开资料研究与综合分析"}</strong><p>{study.report.citations.length} 个来源，{study.personas.length} 个 Persona，{study.interviews.length} 份模拟访谈，{study.report.content.findings.length} 项洞察</p></div>
        {study.panel ? <StudyPanelOpenButton publicId={study.panel.publicId} /> : null}
      </div>
      <section className="agent-limitations">
        <h3>研究局限</h3>
        <ul>{study.report.content.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        <p>公开资料和 AI 合成 Persona 可用于发现假设与压力测试；涉及购买意愿、用户占比和优先级排序时，仍建议通过真人研究或实际市场测试验证。</p>
      </section>
      <section className="agent-next-questions">
        <h3>可以继续追问</h3>
        <StudyFollowupSuggestions questions={study.report.content.nextQuestions} />
      </section>
      <div className="agent-output-title"><span />研究产出</div>
      <button type="button" className="agent-podcast" disabled><span><FileCheck2 size={19} /></span>生成播客，聆听研究成果的深度解读</button>
    </section>
  );
}

function FollowupThread({ study }: { study: StudyDetail }) {
  const messages = study.messages.filter((message) => message.partType === "followup_question" || message.partType === "followup_answer");
  if (!messages.length) return null;

  return (
    <section className="agent-followup-thread" aria-label="报告追问记录">
      <h2>报告追问</h2>
      {messages.map((message) => {
        const citations = Array.isArray(message.payload.citations)
          ? message.payload.citations.flatMap((citation) => {
              if (!citation || typeof citation !== "object") return [];
              const title = "title" in citation && typeof citation.title === "string" ? citation.title : "公开来源";
              const url = "url" in citation && typeof citation.url === "string" ? citation.url : "";
              return url ? [{ title, url }] : [];
            })
          : [];
        const caveat = typeof message.payload.caveat === "string" ? message.payload.caveat : "";
        const user = message.role === "user";
        return (
          <article className={`agent-message ${user ? "agent-user-message agent-followup-user" : "agent-followup-answer"}`} key={message.id}>
            <span className={`agent-avatar ${user ? "" : "agent-avatar-ai"}`}>{user ? <UserRound size={16} /> : <Bot size={17} />}</span>
            <div className="agent-message-content">
              <strong>{user ? "您" : "atypica.AI"}</strong>
              {user
                ? <p>{message.content}</p>
                : <StructuredFollowupAnswer content={message.content} presentation={message.payload.presentation} />}
              {!user && caveat ? <div className="agent-answer-caveat"><strong>证据边界</strong><p>{caveat}</p></div> : null}
              {!user && citations.length ? <div className="agent-answer-citations">{citations.map((citation) => <a href={citation.url} target="_blank" rel="noreferrer" key={citation.url}>{citation.title}</a>)}</div> : null}
            </div>
          </article>
        );
      })}
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
  const progressItems = createProgressItems(study);
  const initialArtifactId = study.artifacts.findLast((artifact) => artifact.type === "research_report")?.publicId ?? null;

  return (
    <StudyArtifactConsoleProvider initialArtifactId={initialArtifactId}>
    <main className="agent-workspace-shell">
      <section className="agent-conversation-pane">
        <header className="agent-workspace-header">
          <Link href="/newstudy" className="agent-wordmark">atypica.AI</Link>
          <nav aria-label="研究工具">
            <button type="button" disabled title="统计面板后续开放"><BarChart3 size={17} />Nerd Stats</button>
            {study.report ? <StudyShareControls publicId={study.publicId} initialEnabled={study.report.shareEnabled} initialToken={study.report.shareToken} /> : null}
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
          <FollowupThread study={study} />
          {!study.report ? <div className="agent-stream-spacer" /> : null}
        </div>
        <StudyAgentControls study={study} progressItems={progressItems} />
      </section>
      <StudyAgentConsole study={study} />
    </main>
    </StudyArtifactConsoleProvider>
  );
}

function createProgressItems(study: StudyDetail): ProgressDefinition[] {
  if (study.tasks.length > 0) {
    return study.tasks.map((task) => ({
      key: task.key,
      label: task.title,
      toolName: task.toolName,
      startedTypes: [`task.${task.key}.started`],
      completedTypes: [`task.${task.key}.completed`],
      activeSummary: `正在执行 ${task.title}。工具输出和进度会持久化到当前研究运行。`,
      completedSummary: `${task.title}已完成，结果已写入研究 checkpoint。`,
      status: task.status === "completed" || task.status === "skipped"
        ? "done"
        : task.status === "running"
          ? "active"
          : task.status === "failed"
            ? "failed"
            : "waiting",
    }));
  }

  const runEvents = study.events.filter((event) => !study.runId || event.runId === study.runId || event.runId === null);
  const eventTypes = new Set(runEvents.map((event) => event.type));
  const failed = study.runStatus === "failed" || study.runRecoverable;
  const running = (study.runStatus === "queued" || study.runStatus === "running") && !study.runRecoverable;
  const researchCompleted = study.runStatus === "completed" || Boolean(study.report);
  const completedCount = progressDefinitions.findLastIndex((definition) => definition.completedTypes.some((type) => eventTypes.has(type))) + 1;

  return progressDefinitions.map((definition, index) => ({
    ...definition,
    status: researchCompleted || definition.completedTypes.some((type) => eventTypes.has(type))
      ? "done" as const
      : failed && (definition.startedTypes.some((type) => eventTypes.has(type)) || index === completedCount)
        ? "failed" as const
        : definition.startedTypes.some((type) => eventTypes.has(type)) || running && index === completedCount
          ? "active" as const
          : "waiting" as const,
  }));
}
