import {
  ArrowLeft,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Database,
  GitCompareArrows,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StudyRunCompareControls } from "@/components/study-run-compare-controls";
import { getViewer } from "@/lib/auth";
import { getStudyRunComparison, type StudyRunReplaySnapshot } from "@/lib/study-run-replay";
import { formatDuration, formatTokens } from "@/lib/study-display";

function shortHash(value: string | null) {
  return value ? `${value.slice(0, 12)}…` : "—";
}

function formatRunDuration(milliseconds: number | null) {
  if (milliseconds === null) return "—";
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    waiting_input: "等待输入",
    running: "执行中",
    queued: "排队中",
    awaiting_provider: "等待 Provider",
  };
  return labels[status] ?? status;
}

function RunReplayPane({ run, side }: { run: StudyRunReplaySnapshot; side: "A" | "B" }) {
  const completed = run.status === "completed";
  return (
    <article className="study-run-replay-pane">
      <header>
        <span>{side}</span>
        <div>
          <p>第 {run.attempt} 次执行 · Plan v{run.planVersion}</p>
          <h2>{statusLabel(run.status)}</h2>
        </div>
        <strong className={completed ? "is-complete" : "is-warning"}>
          {completed ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
          {run.counts.completedTasks}/{run.counts.tasks}
        </strong>
      </header>

      <section className="study-run-metric-strip" aria-label="运行结果">
        <div><span>耗时</span><strong>{formatRunDuration(run.durationMs)}</strong></div>
        <div><span>Tokens</span><strong>{formatTokens(run.totalTokens)}</strong></div>
        <div><span>重试</span><strong>{run.counts.taskRetries}</strong></div>
        <div><span>产物</span><strong>{run.counts.artifacts}</strong></div>
      </section>

      {run.trajectoryEvaluation ? (
        <section className="study-run-replay-section" aria-label="Agent 轨迹评估">
          <header><GitCompareArrows size={15} /><h3>Agent 轨迹评估</h3><span>{run.trajectoryEvaluation.controllerMode}</span></header>
          <dl className="study-run-version-list">
            <div><dt>策略拒绝率</dt><dd>{Math.round(Number(run.trajectoryEvaluation.metrics.policyRejectRate ?? 0) * 100)}%</dd></div>
            <div><dt>工具选择匹配率</dt><dd>{Math.round(Number(run.trajectoryEvaluation.metrics.callToolMatchRate ?? 0) * 100)}%</dd></div>
            <div><dt>来源 / 域名增益</dt><dd>{String(run.trajectoryEvaluation.metrics.sourceCount ?? 0)} / {String(run.trajectoryEvaluation.metrics.distinctDomainCount ?? 0)}</dd></div>
            <div><dt>决策延迟</dt><dd>{run.trajectoryEvaluation.metrics.decisionLatencyMs === null ? "—" : `${Math.round(Number(run.trajectoryEvaluation.metrics.decisionLatencyMs))}ms`}</dd></div>
            <div><dt>恢复 / 人工介入</dt><dd>{String(run.trajectoryEvaluation.metrics.recoveryEventCount ?? 0)} / {String(run.trajectoryEvaluation.metrics.humanInterventionCount ?? 0)}</dd></div>
            <div><dt>报告 gate</dt><dd>{run.trajectoryEvaluation.metrics.reportGatePassed ? "通过" : "未通过"}</dd></div>
          </dl>
        </section>
      ) : null}

      <section className="study-run-replay-section">
        <header><Workflow size={15} /><h3>锁定版本</h3></header>
        <dl className="study-run-version-list">
          <div><dt>产品线</dt><dd>{run.plan.productLine === "market_insight" ? "Market Insight" : "Research"}</dd></div>
          <div><dt>Plan</dt><dd>v{run.planVersion} · {run.plan.schemaVersion}</dd></div>
          <div><dt>Plan hash</dt><dd title={run.plan.contentHash}>{shortHash(run.plan.contentHash)}</dd></div>
          <div><dt>Intent</dt><dd>{run.intent ? `v${run.intent.version} · ${run.intent.schemaVersion}` : "Legacy / 未绑定"}</dd></div>
          <div><dt>Intent hash</dt><dd title={run.intent?.contentHash}>{shortHash(run.intent?.contentHash ?? null)}</dd></div>
          <div><dt>Workflow</dt><dd>{run.workflowDefinition ? `v${run.workflowDefinition.version} · ${run.workflowDefinition.templateVersion}` : run.versions.workflowVersion}</dd></div>
          <div><dt>Workflow hash</dt><dd title={run.workflowDefinition?.contentHash}>{shortHash(run.workflowDefinition?.contentHash ?? null)}</dd></div>
          <div><dt>Strategy</dt><dd>{run.versions.strategyKey}@{run.versions.strategyVersion}</dd></div>
          <div><dt>Reasoning</dt><dd>{run.versions.reasoningPolicyVersion}</dd></div>
          <div><dt>Prompt</dt><dd>{run.versions.promptVersion ?? "—"}</dd></div>
          <div><dt>Provider</dt><dd>{run.provider ?? "—"}{run.model ? ` / ${run.model}` : ""}</dd></div>
          <div><dt>Skills</dt><dd>{run.skills.map((skill) => `${skill.slug}@${skill.version}`).join(", ") || "—"}</dd></div>
        </dl>
      </section>

      <section className="study-run-replay-section">
        <header><Database size={15} /><h3>Plan 与 Context</h3></header>
        <div className="study-run-plan-summary">
          <p>{run.plan.rationale}</p>
          <dl>
            <div><dt>框架</dt><dd>{run.plan.framework}</dd></div>
            <div><dt>方法</dt><dd>{run.plan.methods.join(" + ") || "公开资料综合"}</dd></div>
            <div><dt>Persona</dt><dd>{run.plan.personaCount} 人</dd></div>
            <div><dt>预计周期</dt><dd>{formatDuration(run.plan.estimatedDurationMinutes)}</dd></div>
          </dl>
        </div>
        <dl className="study-run-version-list context-list">
          <div><dt>Planning Context</dt><dd>{run.intent?.contextRetrievalPublicId ?? "Legacy / 未绑定"}</dd></div>
          <div><dt>Planning 引用</dt><dd>{run.intent?.contextCitationCount ?? 0}</dd></div>
          <div><dt>Execution Retrieval</dt><dd>{run.context?.strategy ?? "—"}</dd></div>
          <div><dt>Embedding</dt><dd>{run.context?.embeddingModel ? `${run.context.embeddingModel}@${run.context.embeddingVersion}` : "—"}</dd></div>
          <div><dt>Purpose</dt><dd>{run.context?.purpose ?? "—"}</dd></div>
          <div><dt>Memory Policy</dt><dd>{run.context?.policyVersion ?? "—"}</dd></div>
          <div><dt>拒绝 Memory</dt><dd>{typeof run.context?.policyDecision.deniedMemoryChunks === "number" ? run.context.policyDecision.deniedMemoryChunks : 0}</dd></div>
          <div><dt>引用 chunk</dt><dd>{run.context?.itemCount ?? 0}</dd></div>
          <div><dt>Checkpoint</dt><dd>{run.checkpoint.cursor} · {shortHash(run.checkpoint.stateHash)}</dd></div>
          <div><dt>编译任务</dt><dd>{run.workflowDefinition?.taskCount ?? "—"}</dd></div>
          <div><dt>Compiler</dt><dd>{run.workflowDefinition?.compilerVersion ?? "—"}</dd></div>
        </dl>
      </section>

      <section className="study-run-replay-section">
        <header><Boxes size={15} /><h3>任务图</h3><span>{run.counts.dynamicTasks} 个动态任务</span></header>
        <ol className="study-run-task-list">
          {run.tasks.map((task) => (
            <li key={task.key}>
              <i className={`task-${task.status}`} />
              <div><strong>{task.title}</strong><p>{task.toolName} · {task.origin === "dynamic" ? `动态第 ${task.generation} 代` : "计划任务"}</p></div>
              <span>{task.attempt} 次</span>
            </li>
          ))}
          {!run.tasks.length ? <li className="is-empty">此 Run 尚未物化任务。</li> : null}
        </ol>
      </section>

      <section className="study-run-replay-section">
        <header><GitCompareArrows size={15} /><h3>决策与产物</h3></header>
        <ol className="study-run-decision-list">
          {run.decisions.map((decision) => (
            <li key={`${decision.sequence}-${decision.createdAt}`}>
              <span>#{decision.sequence + 1}</span>
              <div><strong>{decision.action}</strong><p>{decision.reason}</p></div>
            </li>
          ))}
          {!run.decisions.length ? <li className="is-empty">没有动态调度决策。</li> : null}
        </ol>
        <ul className="study-run-artifact-list">
          {run.artifacts.map((artifact) => (
            <li key={artifact.publicId}><span>{artifact.type}</span><strong>{artifact.title}</strong><code title={artifact.contentHash}>{shortHash(artifact.contentHash)}</code></li>
          ))}
        </ul>
      </section>

      <details className="study-run-timeline">
        <summary>事件时间线 <span>{run.timeline.length} 条</span></summary>
        <ol>{run.timeline.map((event) => (
          <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN")}</time><code>{event.type}</code></li>
        ))}</ol>
      </details>
    </article>
  );
}

export default async function StudyRunComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ left?: string; right?: string }>;
}) {
  const [{ publicId }, query, viewer] = await Promise.all([params, searchParams, getViewer()]);
  if (!viewer) redirect(`/auth/signin?callbackUrl=${encodeURIComponent(`/study/${publicId}/compare`)}`);

  const comparison = await getStudyRunComparison(viewer, publicId, query.left, query.right);
  if (!comparison) notFound();

  return (
    <main className="study-compare-page">
      <header className="study-compare-header">
        <div>
          <Link href={`/study/${publicId}`} aria-label="返回研究"><ArrowLeft size={18} /></Link>
          <span><GitCompareArrows size={18} /></span>
          <div><p>RUN REPLAY COMPARISON</p><h1>{comparison.study.title}</h1></div>
        </div>
        <strong>{comparison.options.length} 个 Run</strong>
      </header>

      {comparison.options.length > 1 && comparison.left && comparison.right ? (
        <>
          <StudyRunCompareControls
            studyPublicId={publicId}
            options={comparison.options}
            initialLeft={comparison.left.publicId}
            initialRight={comparison.right.publicId}
          />
          <section className="study-compare-diff-summary" aria-label="版本差异摘要">
            <span>{comparison.differences.length ? `${comparison.differences.length} 类差异` : "版本与结果一致"}</span>
            <div>{comparison.differences.map((difference) => <strong key={difference}>{difference}</strong>)}</div>
          </section>
          <section className="study-run-replay-grid">
            <RunReplayPane run={comparison.left} side="A" />
            <RunReplayPane run={comparison.right} side="B" />
          </section>
        </>
      ) : (
        <section className="study-compare-empty">
          <GitCompareArrows size={28} />
          <h2>还没有可比较的 Run</h2>
          <p>同一研究产生至少两次运行后，这里会显示计划、版本、任务、决策和结果差异。</p>
          <Link href={`/study/${publicId}`}>返回研究</Link>
        </section>
      )}
    </main>
  );
}
