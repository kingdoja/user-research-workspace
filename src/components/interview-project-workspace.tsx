"use client";

import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  FileBarChart,
  FileText,
  Settings2,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  MessageCircleMore,
  Quote,
  RotateCcw,
  Trash2,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { InterviewProjectDetail } from "@/lib/interviews";
import { InterviewProjectSettings } from "@/components/interview-project-settings";
import { InterviewAnalysisView } from "@/components/interview-analysis-view";
import { InterviewReportView } from "@/components/interview-report-view";
import { InterviewSessionEvaluation } from "@/components/interview-session-evaluation";
import { buildInterviewDifferences, buildInterviewHypotheses, buildInterviewThemes } from "@/lib/interview-analysis";

type ProjectView = "sessions" | "questions" | "report" | "settings";

function formatQuote(quote: string) {
  return quote.replace(/^[“”"']+|[“”"']+$/g, "").trim();
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-");
}

const RUN_STAGES = [
  { key: "run.started", label: "任务已启动", detail: "已领取本次生成任务" },
  { key: "personas.loaded", label: "Persona 已准备", detail: "载入项目选择的研究对象" },
  { key: "provider.request.started", label: "生成模拟访谈", detail: "等待模型返回结构化会话" },
  { key: "provider.response.received", label: "整理生成结果", detail: "校验问题、回答和洞察结构" },
  { key: "sessions.persisted", label: "保存访谈记录", detail: "写入问题、会话和逐轮消息" },
] as const;

function formatRunTime(value: string | null) {
  if (!value) return "尚未开始";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function InterviewProjectWorkspace({ project }: { project: InterviewProjectDetail }) {
  const router = useRouter();
  const [view, setView] = useState<ProjectView>("sessions");
  const [selectedId, setSelectedId] = useState(project.sessions[0]?.publicId ?? "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [citedInsights, setCitedInsights] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const runActive = (project.runStatus === "queued" || project.runStatus === "running") && !project.runRecoverable;
  const selected = project.sessions.find((session) => session.publicId === selectedId) ?? project.sessions[0];
  const aiSessionCount = project.sessions.filter((session) => session.sessionType === "ai").length;
  const humanSessionCount = project.sessions.filter((session) => session.sessionType === "human").length;
  const sourceNotice = aiSessionCount && humanSessionCount
    ? "AI 合成与真人访谈并列展示；来源标签用于区分证据属性。"
    : aiSessionCount
      ? "当前记录均为 AI 合成访谈，不代表真人陈述。"
      : "当前记录均来自真人访谈；少量会话不构成统计结论。";
  const report = useMemo(() => ({
    summaries: project.sessions.map((session) => ({ persona: session.participantName, summary: session.summary })),
    insights: project.sessions.flatMap((session) => session.insights.map((insight) => ({
      sessionPublicId: session.publicId,
      persona: session.participantName,
      insight,
    }))),
    quotes: project.sessions.flatMap((session) => session.quotes.map((quote) => ({
      persona: session.participantName,
      sessionType: session.sessionType,
      quote: formatQuote(quote),
    }))),
  }), [project.sessions]);

  useEffect(() => {
    if (!runActive) return;
    const interval = window.setInterval(() => router.refresh(), 2500);
    return () => window.clearInterval(interval);
  }, [router, runActive]);

  function downloadMarkdown() {
    const themes = buildInterviewThemes(project);
    const differences = buildInterviewDifferences(project);
    const hypotheses = buildInterviewHypotheses(themes);
    const questions = project.questions.map((question) => [
      `## ${question.index}. ${question.question}`,
      ...question.answers.map((answer) => `### ${answer.personaName}（${answer.sessionType === "ai" ? "AI 合成 Persona" : "真人参与者"}）\n\n${answer.answer}`),
    ].join("\n\n")).join("\n\n");
    const summaries = report.summaries.map((item) => `### ${item.persona}\n\n${item.summary}`).join("\n\n");
    const insights = report.insights.map((item) => `- **${item.persona}**：${item.insight}`).join("\n");
    const quotes = report.quotes.map((item) => `> “${item.quote}”\n>\n> — ${item.sessionType === "ai" ? "AI 合成 Persona" : "真人参与者"} ${item.persona}`).join("\n\n");
    const exportNotice = aiSessionCount && humanSessionCount
      ? "本记录同时包含 AI 合成与真人访谈，具体来源见每条标签；AI 内容不代表真人陈述，少量真人会话不构成统计结论。"
      : aiSessionCount
        ? "本记录由 AI 合成 Persona 模拟生成，不代表真人陈述、真实引语或统计结论。"
        : "本记录来自真人访谈；少量会话不构成统计结论。";
    const markdown = [
      `# ${project.title}`,
      `**访谈目标**：${project.objective}`,
      `**访谈会话**：${project.sessionCount} 场（AI ${aiSessionCount} / 真人 ${humanSessionCount}）  \n**状态**：${project.status}`,
      `## 项目摘要\n\n${summaries}`,
      `## 关键洞察\n\n${insights}`,
      `## 跨会话主题\n\n${themes.map((theme) => `- **${theme.label}**：${theme.insight}`).join("\n")}`,
      `## 关注差异\n\n${differences.map((difference) => `### ${difference.question}\n\n${difference.answers.map((answer) => `- **${answer.participantName}**：${answer.excerpt}`).join("\n")}`).join("\n\n")}`,
      `## 待验证假设\n\n${hypotheses.map((hypothesis) => `- ${hypothesis.statement}\n  - 验证方式：${hypothesis.validation}`).join("\n")}`,
      `## 代表性表达\n\n${quotes}`,
      `# 逐题访谈记录\n\n${questions}`,
      `---\n${exportNotice}`,
    ].join("\n\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(project.title)}-访谈记录.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function updateStatus(status: "completed" | "archived") {
    setError(""); setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法更新项目"); return; }
      setNotice(status === "archived" ? "项目已归档" : "项目已恢复");
      router.refresh();
    });
  }

  function removeProject() {
    if (!window.confirm(`确定删除“${project.title}”吗？访谈会话和消息将一并删除，且无法恢复。`)) return;
    setError("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法删除项目"); return; }
      router.replace("/interview/projects");
      router.refresh();
    });
  }

  function citeInsight(sessionPublicId: string, insight: string) {
    setError(""); setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}/insights`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionPublicId, insight }),
      });
      const result = await response.json() as { error?: string; duplicate?: boolean };
      if (!response.ok) { setError(result.error ?? "暂时无法引用该洞察"); return; }
      setCitedInsights((current) => [...current, insight]);
      setNotice(result.duplicate ? "该洞察已存在于研究报告中" : "洞察已加入关联研究报告");
    });
  }

  function retryRun() {
    setError(""); setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}/run`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法重新执行"); return; }
      setNotice("生成任务已重新排队");
      router.refresh();
    });
  }

  return (
    <div className="interview-workspace">
      <header className="interview-workspace-header">
        <div><Link href="/interview/projects"><ArrowLeft size={15} />访谈项目</Link><h1>{project.title}</h1></div>
        <div className="interview-project-actions">
          <span className={`interview-status ${project.status}`}>{project.status === "archived" ? "已归档" : runActive ? "生成中" : project.runStatus === "failed" || project.runRecoverable ? "生成失败" : project.status === "active" ? "配置中" : "已完成"}</span>
          <button type="button" onClick={downloadMarkdown} title="导出 Markdown" aria-label="导出访谈记录"><Download size={16} /></button>
          <button type="button" disabled={pending} onClick={() => updateStatus(project.status === "archived" ? "completed" : "archived")} title={project.status === "archived" ? "恢复项目" : "归档项目"} aria-label={project.status === "archived" ? "恢复项目" : "归档项目"}>{project.status === "archived" ? <RotateCcw size={16} /> : <Archive size={16} />}</button>
          <button className="danger" type="button" disabled={pending} onClick={removeProject} title="删除项目" aria-label="删除项目"><Trash2 size={16} /></button>
        </div>
      </header>
      <nav className="interview-view-tabs" aria-label="访谈项目视图">
        <button className={view === "sessions" ? "active" : ""} type="button" onClick={() => setView("sessions")}><MessageCircleMore size={15} />访谈记录<span>{project.sessionCount}</span></button>
        <button className={view === "questions" ? "active" : ""} type="button" onClick={() => setView("questions")}><ListChecks size={15} />逐题分析<span>{project.questions.length}</span></button>
        <button className={view === "report" ? "active" : ""} type="button" onClick={() => setView("report")}><FileBarChart size={15} />项目报告</button>
        <button className={view === "settings" ? "active" : ""} type="button" onClick={() => setView("settings")}><Settings2 size={15} />配置与邀请</button>
      </nav>
      {error || notice ? <div className={error ? "interview-action-message error" : "interview-action-message"} role={error ? "alert" : "status"}>{pending ? <LoaderCircle className="spin" size={14} /> : error ? null : <Check size={14} />}{error || notice}</div> : null}

      {view === "sessions" && selected ? <div className="interview-workspace-grid">
        <aside className="interview-session-rail">
          <div><span>访谈参与者</span><strong>{project.sessionCount}</strong></div>
          <nav aria-label="访谈参与者">{project.sessions.map((session, index) => (
            <button type="button" className={session.publicId === selected.publicId ? "active" : ""} onClick={() => setSelectedId(session.publicId)} key={session.publicId}>
              <i>{String(index + 1).padStart(2, "0")}</i><span><strong>{session.participantName}</strong><small>{session.persona?.profile.occupation ?? "真人参与者"}</small></span>
            </button>
          ))}</nav>
          <footer><Bot size={14} /><span>{sourceNotice}</span></footer>
        </aside>
        <main className="interview-transcript-pane">
          <header><div><span>{selected.persona?.archetype ?? "真人参与者"}</span><h2>{selected.participantName}</h2><p>{selected.persona ? `${selected.persona.profile.city} · ${selected.persona.profile.age} 岁 · ${selected.persona.profile.occupation}` : selected.participantEmail ?? "通过邀请链接参与"}</p></div><span>{selected.messages.length} 轮对话</span></header>
          <section className="interview-objective"><strong>访谈目标</strong><p>{project.objective}</p></section>
          <section className="interview-transcript" aria-label={`${selected.participantName} 访谈回放`}>
            {selected.messages.map((message, index) => (
              <article className={message.role === "interviewer" || message.role === "agent" ? "interviewer-turn" : "persona-turn"} key={message.id}>
                <div>{message.role === "interviewer" || message.role === "agent" ? <MessageCircleMore size={16} /> : selected.participantName.slice(0, 1)}</div>
                <section><header><strong>{message.role === "interviewer" || message.role === "agent" ? selected.workflowType === "realtime_agent" ? "访谈 Agent" : "访谈问题" : selected.participantName}</strong><span>{String(index + 1).padStart(2, "0")}</span></header><p>{message.content}</p></section>
              </article>
            ))}
          </section>
        </main>
        <aside className="interview-insight-pane">
          <section><header><FileText size={16} /><h2>会话摘要</h2></header><p>{selected.summary}</p></section>
          <section><header><Lightbulb size={16} /><h2>关键洞察</h2></header><ol>{selected.insights.map((insight, index) => <li key={insight}><span>{String(index + 1).padStart(2, "0")}</span><div><p>{insight}</p>{project.study ? <button type="button" disabled={pending || citedInsights.includes(insight)} onClick={() => citeInsight(selected.publicId, insight)}>{citedInsights.includes(insight) ? <><Check size={11} />已引用</> : "加入研究报告"}</button> : null}</div></li>)}</ol></section>
          <section><header><Quote size={16} /><h2>{selected.sessionType === "ai" ? "合成引用" : "访谈引用"}</h2></header>{selected.quotes.map((quote) => <blockquote key={quote}>“{formatQuote(quote)}”</blockquote>)}</section>
          <section className="interview-links"><header><UsersRound size={16} /><h2>研究关联</h2></header>{project.panel ? <Link href={`/panel/${project.panel.publicId}`}>Panel<span>{project.panel.title}</span></Link> : null}{project.study ? <Link href={`/study/${project.study.publicId}`}>研究<span>{project.study.title}</span></Link> : null}{!project.panel && !project.study ? <p>该项目暂未关联 Panel 或研究。</p> : null}</section>
          <InterviewSessionEvaluation key={selected.publicId} projectPublicId={project.publicId} sessionPublicId={selected.publicId} workflowType={selected.workflowType} />
        </aside>
      </div> : null}

      {view === "sessions" && !selected && project.runStatus ? <main className="interview-run-view">
        <section className="interview-run-panel">
          <header>
            <div className={project.runStatus === "failed" || project.runRecoverable ? "failed" : project.runStatus === "completed" ? "completed" : "running"}>
              {project.runStatus === "failed" || project.runRecoverable ? <CircleAlert size={22} /> : project.runStatus === "completed" ? <Check size={22} /> : <LoaderCircle className="spin" size={22} />}
            </div>
            <div><span>AI SYNTHETIC INTERVIEW · RUN {String(project.runAttempt).padStart(2, "0")}</span><h2>{project.runStatus === "failed" || project.runRecoverable ? "访谈生成未完成" : project.runStatus === "completed" ? "访谈生成已完成" : "正在生成模拟访谈"}</h2><p>{project.runStatus === "queued" ? "任务已进入队列，正在等待执行。" : project.runStatus === "running" ? "页面可以安全关闭，重新打开后会继续显示最新状态。" : project.runError ?? "正在加载访谈会话。"}</p></div>
          </header>
          {project.runStatus === "failed" || project.runRecoverable ? <div className="interview-run-error"><strong>{project.runRecoverable ? "任务执行已中断" : "上游服务返回错误"}</strong><p>{project.runRecoverable ? "任务超过 10 分钟没有新事件，可以从当前项目重新生成。" : project.runError}</p><button type="button" disabled={pending} onClick={retryRun}>{pending ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}重新执行</button></div> : null}
          <ol className="interview-run-stages">{RUN_STAGES.map((stage, index) => {
            const eventIndex = project.runEvents.findIndex((event) => event.type === stage.key);
            const done = eventIndex >= 0;
            const nextPending = !done && RUN_STAGES.slice(0, index).every((candidate) => project.runEvents.some((event) => event.type === candidate.key));
            const current = runActive && nextPending;
            return <li className={done ? "done" : current ? "current" : ""} key={stage.key}><i>{done ? <Check size={12} /> : current ? <LoaderCircle className="spin" size={12} /> : index + 1}</i><div><strong>{stage.label}</strong><p>{stage.detail}</p></div><span>{done ? "完成" : current ? "进行中" : "等待"}</span></li>;
          })}</ol>
          {project.runHistory.length > 0 ? <details className="interview-run-history">
            <summary><ChevronRight size={14} /><strong>执行历史</strong><span>{project.runHistory.length} 次</span></summary>
            <ol>{project.runHistory.toReversed().map((run) => <li key={run.publicId}><i className={run.status} /><div><strong>第 {run.attempt} 次执行 · {run.status === "completed" ? "已完成" : run.status === "failed" ? "失败" : run.status === "running" ? "执行中" : "排队中"}</strong><p>{run.provider ?? "模型服务"}{run.model ? ` · ${run.model}` : ""}</p>{run.error ? <small>{run.error}</small> : null}</div><time>{formatRunTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}</time></li>)}</ol>
          </details> : null}
        </section>
      </main> : null}

      {view === "sessions" && !selected && !project.runStatus ? <main className="interview-empty-sessions"><MessageCircleMore size={26} /><h2>还没有访谈会话</h2><p>请前往“配置与邀请”添加问题并生成真人访谈链接。</p><button type="button" onClick={() => setView("settings")}><Settings2 size={15} />配置访谈</button></main> : null}

      {view === "questions" ? <InterviewAnalysisView project={project} /> : null}
      {view === "report" ? <InterviewReportView project={project} onDownload={downloadMarkdown} onOpenSession={(sessionPublicId) => { setSelectedId(sessionPublicId); setView("sessions"); }} /> : null}
      {view === "settings" ? <InterviewProjectSettings project={project} /> : null}
    </div>
  );
}
