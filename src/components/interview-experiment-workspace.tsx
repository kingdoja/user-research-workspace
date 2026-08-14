"use client";

import {
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Database,
  FlaskConical,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Scale,
  Star,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import type { StrategyExperimentSummary } from "@/lib/runtime-control";

type SessionCandidate = {
  sessionPublicId: string;
  projectPublicId: string;
  projectTitle: string;
  participantName: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  turnCount: number;
  contextRetrievalPublicId: string | null;
  workflowVersion: string;
  skill: { slug: string; version: number | null } | null;
  strategyKey: string;
  strategyVersion: string;
  variantKey: string;
  assignmentPublicId: string;
  latestQualityScore: number | null;
  questionCoverageRate: number | null;
  followupHitRate: number | null;
  taskRetries: number | null;
};

type Comparison = {
  experiment: StrategyExperimentSummary;
  variants: Array<StrategyExperimentSummary["variants"][number] & { sessions: SessionCandidate[] }>;
};

type Replay = {
  sessionPublicId: string;
  workflow: { type: string; version: string; status: string };
  skill: { slug: string; version: number | null } | null;
  strategy: { key: string; version: string };
  context: { retrievalPublicId: string; strategy: string | null; citations: Array<{ rank: number; title: string; version: number; source_uri: string | null }> } | null;
  startedAt: string | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  metrics: {
    questionCount: number;
    answeredQuestionCount: number;
    coverageRate: number;
    followupRequestedCount: number;
    followupAnsweredCount: number;
    followupHitRate: number;
    substantiveAnswerCount: number;
    metricVersion: string;
  } | null;
  messages: Array<{
    public_id: string;
    turn_index: number;
    role: string;
    message_type: string;
    content: string;
    provider_response_id: string | null;
    provider_model: string | null;
    prompt_version: string | null;
    created_at: string;
  }>;
  reviews: Array<{
    reviewer_name: string;
    relevance: number;
    depth: number;
    followup_quality: number;
    consistency: number;
    evidence_grounding: number;
    safety_compliance: number;
    overall_score: number;
    notes: string;
    updated_at: string;
  }>;
};

type ComparisonResponse = {
  comparison: Comparison;
  selected: { left: string | null; right: string | null };
  replays: { left: Replay | null; right: Replay | null };
  error?: string;
};

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function compactNumber(value: number | null) {
  if (value === null) return "--";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, notation: "compact" }).format(value);
}

function duration(value: number | null) {
  if (value === null) return "--";
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function dateTime(value: string | null) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function statusLabel(status: string) {
  return ({ draft: "草稿", active: "运行中", paused: "已暂停", completed: "已结束", failed: "失败", cancelled: "已取消", responding: "生成中", waiting_participant: "进行中" } as Record<string, string>)[status] ?? status;
}

function ReplayPane({ side, session, replay }: { side: "A" | "B"; session: SessionCandidate | null; replay: Replay | null }) {
  if (!session || !replay) return <section className="experiment-replay-pane empty"><Scale size={22} /><h3>选择一场会话</h3><p>从上方选择器载入该 variant 的版本和逐轮对话。</p></section>;
  const review = replay.reviews[0];
  const providerTurns = replay.messages.filter((message) => message.provider_response_id).length;
  const promptVersions = [...new Set(replay.messages.map((message) => message.prompt_version).filter(Boolean))];
  return <section className="experiment-replay-pane">
    <header>
      <span>{side}</span>
      <div><h3>{session.participantName}</h3><p>{session.projectTitle} · {dateTime(session.startedAt)}</p></div>
      <Link href={`/interview/projects/${session.projectPublicId}`}>项目</Link>
    </header>
    <dl className="experiment-replay-meta">
      <div><dt>Workflow</dt><dd>{replay.workflow.version}</dd></div>
      <div><dt>Skill</dt><dd>{replay.skill ? `${replay.skill.slug}@${replay.skill.version ?? "?"}` : "未绑定"}</dd></div>
      <div><dt>Strategy</dt><dd>{replay.strategy.key} / {replay.strategy.version}</dd></div>
      <div><dt>Context</dt><dd>{replay.context?.retrievalPublicId ?? "无命中"}</dd></div>
      <div><dt>Prompt</dt><dd>{promptVersions.join(", ") || "--"}</dd></div>
      <div><dt>Provider turns</dt><dd>{providerTurns}</dd></div>
      <div><dt>Question coverage</dt><dd>{replay.metrics ? `${percent(replay.metrics.coverageRate)} · ${replay.metrics.answeredQuestionCount}/${replay.metrics.questionCount}` : "--"}</dd></div>
      <div><dt>Follow-up hit</dt><dd>{replay.metrics ? `${percent(replay.metrics.followupHitRate)} · ${replay.metrics.followupAnsweredCount}/${replay.metrics.followupRequestedCount}` : "--"}</dd></div>
      <div><dt>Task retries</dt><dd>{session.taskRetries === null ? "--" : compactNumber(session.taskRetries)}</dd></div>
    </dl>
    {replay.context?.citations.length ? <details className="experiment-citations"><summary><Database size={13} />Context 引用 · {replay.context.citations.length}</summary><ol>{replay.context.citations.map((citation) => <li key={`${citation.rank}-${citation.title}`}><span>{citation.rank}</span><div><strong>{citation.title}</strong><small>v{citation.version}{citation.source_uri ? ` · ${citation.source_uri}` : ""}</small></div></li>)}</ol></details> : null}
    <div className="experiment-transcript" aria-label={`${side} 会话回放`}>
      {replay.messages.map((message) => <article className={message.role === "participant" || message.role === "persona" ? "participant" : "agent"} key={message.public_id}>
        <header><span>{message.role === "participant" || message.role === "persona" ? "参与者" : "Agent"}</span><small>#{message.turn_index} · {message.message_type}</small></header>
        <p>{message.content}</p>
        {message.provider_model ? <footer>{message.provider_model} · {message.prompt_version ?? "prompt 未记录"}</footer> : null}
      </article>)}
    </div>
    <div className="experiment-review">
      <header><Star size={14} /><strong>人工质量评估</strong><span>{review ? `${Number(review.overall_score).toFixed(1)} / 5` : "未评分"}</span></header>
      {review ? <><dl><div><dt>相关</dt><dd>{review.relevance}</dd></div><div><dt>深度</dt><dd>{review.depth}</dd></div><div><dt>追问</dt><dd>{review.followup_quality}</dd></div><div><dt>一致</dt><dd>{review.consistency}</dd></div><div><dt>证据</dt><dd>{review.evidence_grounding}</dd></div><div><dt>安全</dt><dd>{review.safety_compliance}</dd></div></dl>{review.notes ? <p>{review.notes}</p> : null}</> : <p>该会话尚未经过人工复核。</p>}
    </div>
  </section>;
}

export function InterviewExperimentWorkspace({ experiments }: { experiments: StrategyExperimentSummary[] }) {
  const [activeId, setActiveId] = useState(experiments[0]?.publicId ?? "");
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function load(experimentPublicId: string, left?: string | null, right?: string | null) {
    setError("");
    startTransition(async () => {
      const params = new URLSearchParams();
      if (left !== undefined || right !== undefined) {
        params.set("leftSession", left ?? "");
        params.set("rightSession", right ?? "");
      }
      const suffix = params.size ? `?${params}` : "";
      try {
        const response = await fetch(`/api/experiments/${experimentPublicId}/comparison${suffix}`);
        const result = await response.json() as ComparisonResponse;
        if (!response.ok) { setError(result.error ?? "实验数据读取失败"); return; }
        setData(result);
      } catch {
        setError("实验数据读取失败");
      }
    });
  }

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    fetch(`/api/experiments/${activeId}/comparison`)
      .then(async (response) => ({ response, result: await response.json() as ComparisonResponse }))
      .then(({ response, result }) => {
        if (cancelled) return;
        if (!response.ok) { setError(result.error ?? "实验数据读取失败"); return; }
        setData(result);
      })
      .catch(() => { if (!cancelled) setError("实验数据读取失败"); });
    return () => { cancelled = true; };
  }, [activeId]);

  if (!experiments.length) return <div className="experiment-page workspace-page">
    <header className="experiment-page-heading"><div><span>Realtime Agent Evaluation</span><h1>访谈实验</h1><p>比较不同 Agent 策略的运行指标、版本依赖和真实逐轮回放。</p></div><Link className="button" href="/interview/projects"><ArrowLeft size={16} />访谈项目</Link></header>
    <section className="experiment-empty"><FlaskConical size={28} /><h2>还没有实时访谈实验</h2><p>创建并启用 realtime_agent 实验后，参与者会被稳定分配到不同策略；完成的会话将在这里进行指标和回放比较。</p><Link href="/interview/projects"><MessageSquareText size={16} />返回访谈项目</Link></section>
  </div>;

  const comparison = data?.comparison;
  const sessions = comparison?.variants.flatMap((variant) => variant.sessions) ?? [];
  const selectedLeft = sessions.find((session) => session.sessionPublicId === data?.selected.left) ?? null;
  const selectedRight = sessions.find((session) => session.sessionPublicId === data?.selected.right) ?? null;
  return <div className="experiment-page workspace-page">
    <header className="experiment-page-heading"><div><span>Realtime Agent Evaluation</span><h1>访谈实验</h1><p>在聚合指标之外，直接检查每个策略的 Skill、Context、Prompt 和逐轮行为。</p></div><Link className="button" href="/interview/projects"><ArrowLeft size={16} />访谈项目</Link></header>
    <nav className="experiment-tabs" aria-label="实验列表">{experiments.map((experiment) => <button type="button" className={activeId === experiment.publicId ? "active" : ""} onClick={() => setActiveId(experiment.publicId)} key={experiment.publicId}><span>{experiment.name}</span><small>{statusLabel(experiment.status)} · {experiment.variants.length} variants</small></button>)}</nav>
    {error ? <div className="experiment-error" role="alert"><span>{error}</span><button type="button" onClick={() => load(activeId)}><RefreshCw size={14} />重试</button></div> : null}
    {!comparison && !error ? <div className="experiment-loading"><LoaderCircle className="spin" size={20} />读取实验运行记录...</div> : null}
    {comparison ? <>
      <section className="experiment-summary"><header><div><span>{comparison.experiment.experimentKey}</span><h2>{comparison.experiment.name}</h2></div><p>{comparison.experiment.description || "未填写实验说明"}</p><strong>{statusLabel(comparison.experiment.status)}</strong></header>
        <div className="experiment-metric-table" role="table" aria-label="Variant 指标比较">
          <div className="heading" role="row"><span>Variant</span><span>分配</span><span>完成率</span><span>覆盖率</span><span>追问命中</span><span>平均耗时</span><span>平均 Token</span><span>重试</span><span>人工质量</span></div>
          {comparison.variants.map((variant) => <div role="row" key={variant.variantKey}><span><strong>{variant.name}</strong><small>{variant.variantKey} · {variant.strategyVersion}</small></span><span>{variant.metrics.assignments}</span><span>{percent(variant.metrics.completionRate)}<small>{variant.metrics.completed} 完成 / {variant.metrics.failed} 失败</small></span><span>{variant.metrics.averageQuestionCoverage === null ? "--" : percent(variant.metrics.averageQuestionCoverage)}</span><span>{variant.metrics.averageFollowupHitRate === null ? "--" : percent(variant.metrics.averageFollowupHitRate)}</span><span>{duration(variant.metrics.averageDurationMs)}</span><span>{compactNumber(variant.metrics.averageTokens)}</span><span>{variant.metrics.averageTaskRetries === null ? "--" : compactNumber(variant.metrics.averageTaskRetries)}</span><span>{variant.metrics.averageQualityScore === null ? "--" : `${variant.metrics.averageQualityScore.toFixed(1)} / 5`}</span></div>)}
        </div>
      </section>
      <section className="experiment-comparison">
        <header><div><Scale size={17} /><div><h2>会话版本回放</h2><p>并排检查策略配置与具体行为，不从小样本自动推断胜者。</p></div></div><span><CheckCircle2 size={14} />{sessions.length} 场可比较会话</span></header>
        {sessions.length ? <div className="experiment-selectors">
          {(["left", "right"] as const).map((side, index) => <label key={side}><span>{index === 0 ? "A" : "B"} 会话</span><select value={data?.selected[side] ?? ""} onChange={(event) => load(activeId, side === "left" ? event.target.value || null : data?.selected.left, side === "right" ? event.target.value || null : data?.selected.right)}><option value="">不选择</option>{comparison.variants.map((variant) => <optgroup label={`${variant.name} · ${variant.strategyVersion}`} key={variant.variantKey}>{variant.sessions.map((session) => <option value={session.sessionPublicId} key={session.sessionPublicId}>{session.participantName} · {session.projectTitle} · {statusLabel(session.status)}</option>)}</optgroup>)}</select></label>)}
          {pending ? <LoaderCircle className="spin" size={17} aria-label="正在切换会话" /> : <BarChart3 size={17} />}
        </div> : null}
        {sessions.length ? <div className="experiment-replay-grid"><ReplayPane side="A" session={selectedLeft} replay={data?.replays.left ?? null} /><ReplayPane side="B" session={selectedRight} replay={data?.replays.right ?? null} /></div> : <div className="experiment-no-sessions"><MessageSquareText size={24} /><h3>实验还没有实时会话</h3><p>启用实验并通过公开邀请完成 Agent 访谈后，这里会出现可选回放。</p></div>}
      </section>
    </> : null}
  </div>;
}
