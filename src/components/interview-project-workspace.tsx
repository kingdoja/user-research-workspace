"use client";

import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  Download,
  FileBarChart,
  FileText,
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
import { useMemo, useState, useTransition } from "react";
import type { InterviewProjectDetail } from "@/lib/interviews";

type ProjectView = "sessions" | "questions" | "report";

function formatQuote(quote: string) {
  return quote.replace(/^[“”"']+|[“”"']+$/g, "").trim();
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-");
}

export function InterviewProjectWorkspace({ project }: { project: InterviewProjectDetail }) {
  const router = useRouter();
  const [view, setView] = useState<ProjectView>("sessions");
  const [selectedId, setSelectedId] = useState(project.sessions[0]?.publicId ?? "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [citedInsights, setCitedInsights] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const selected = project.sessions.find((session) => session.publicId === selectedId) ?? project.sessions[0];
  const report = useMemo(() => ({
    summaries: project.sessions.map((session) => ({ persona: session.persona.name, summary: session.summary })),
    insights: project.sessions.flatMap((session) => session.insights.map((insight) => ({
      sessionPublicId: session.publicId,
      persona: session.persona.name,
      insight,
    }))),
    quotes: project.sessions.flatMap((session) => session.quotes.map((quote) => ({
      persona: session.persona.name,
      quote: formatQuote(quote),
    }))),
  }), [project.sessions]);

  function downloadMarkdown() {
    const questions = project.questions.map((question) => [
      `## ${question.index}. ${question.question}`,
      ...question.answers.map((answer) => `### ${answer.personaName}\n\n${answer.answer}`),
    ].join("\n\n")).join("\n\n");
    const summaries = report.summaries.map((item) => `### ${item.persona}\n\n${item.summary}`).join("\n\n");
    const insights = report.insights.map((item) => `- **${item.persona}**：${item.insight}`).join("\n");
    const quotes = report.quotes.map((item) => `> “${item.quote}”\n>\n> — AI 合成 Persona ${item.persona}`).join("\n\n");
    const markdown = [
      `# ${project.title}`,
      `**访谈目标**：${project.objective}`,
      `**参与 Persona**：${project.sessionCount} 个  \n**状态**：${project.status}`,
      `## 项目摘要\n\n${summaries}`,
      `## 关键洞察\n\n${insights}`,
      `## 合成引用\n\n${quotes}`,
      `# 逐题访谈记录\n\n${questions}`,
      "---\n本记录由 AI 合成 Persona 模拟生成，不代表真人陈述、真实引语或统计结论。",
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

  if (!selected) return null;

  return (
    <div className="interview-workspace">
      <header className="interview-workspace-header">
        <div><Link href="/interview/projects"><ArrowLeft size={15} />访谈项目</Link><h1>{project.title}</h1></div>
        <div className="interview-project-actions">
          <span className={`interview-status ${project.status}`}>{project.status === "archived" ? "已归档" : "已完成"}</span>
          <button type="button" onClick={downloadMarkdown} title="导出 Markdown" aria-label="导出访谈记录"><Download size={16} /></button>
          <button type="button" disabled={pending} onClick={() => updateStatus(project.status === "archived" ? "completed" : "archived")} title={project.status === "archived" ? "恢复项目" : "归档项目"} aria-label={project.status === "archived" ? "恢复项目" : "归档项目"}>{project.status === "archived" ? <RotateCcw size={16} /> : <Archive size={16} />}</button>
          <button className="danger" type="button" disabled={pending} onClick={removeProject} title="删除项目" aria-label="删除项目"><Trash2 size={16} /></button>
        </div>
      </header>
      <nav className="interview-view-tabs" aria-label="访谈项目视图">
        <button className={view === "sessions" ? "active" : ""} type="button" onClick={() => setView("sessions")}><MessageCircleMore size={15} />访谈记录<span>{project.sessionCount}</span></button>
        <button className={view === "questions" ? "active" : ""} type="button" onClick={() => setView("questions")}><ListChecks size={15} />逐题分析<span>{project.questions.length}</span></button>
        <button className={view === "report" ? "active" : ""} type="button" onClick={() => setView("report")}><FileBarChart size={15} />项目报告</button>
      </nav>
      {error || notice ? <div className={error ? "interview-action-message error" : "interview-action-message"} role={error ? "alert" : "status"}>{pending ? <LoaderCircle className="spin" size={14} /> : error ? null : <Check size={14} />}{error || notice}</div> : null}

      {view === "sessions" ? <div className="interview-workspace-grid">
        <aside className="interview-session-rail">
          <div><span>参与 Persona</span><strong>{project.sessionCount}</strong></div>
          <nav aria-label="访谈参与 Persona">{project.sessions.map((session, index) => (
            <button type="button" className={session.publicId === selected.publicId ? "active" : ""} onClick={() => setSelectedId(session.publicId)} key={session.publicId}>
              <i>{String(index + 1).padStart(2, "0")}</i><span><strong>{session.persona.name}</strong><small>{session.persona.profile.occupation}</small></span>
            </button>
          ))}</nav>
          <footer><Bot size={14} /><span>所有参与者和对话均为 AI 合成，不代表真人陈述。</span></footer>
        </aside>
        <main className="interview-transcript-pane">
          <header><div><span>{selected.persona.archetype}</span><h2>{selected.persona.name}</h2><p>{selected.persona.profile.city} · {selected.persona.profile.age} 岁 · {selected.persona.profile.occupation}</p></div><span>{selected.messages.length} 轮对话</span></header>
          <section className="interview-objective"><strong>访谈目标</strong><p>{project.objective}</p></section>
          <section className="interview-transcript" aria-label={`${selected.persona.name} 访谈回放`}>
            {selected.messages.map((message, index) => (
              <article className={message.role === "interviewer" ? "interviewer-turn" : "persona-turn"} key={message.id}>
                <div>{message.role === "interviewer" ? <MessageCircleMore size={16} /> : selected.persona.name.slice(0, 1)}</div>
                <section><header><strong>{message.role === "interviewer" ? "AI 访谈员" : selected.persona.name}</strong><span>{String(index + 1).padStart(2, "0")}</span></header><p>{message.content}</p></section>
              </article>
            ))}
          </section>
        </main>
        <aside className="interview-insight-pane">
          <section><header><FileText size={16} /><h2>会话摘要</h2></header><p>{selected.summary}</p></section>
          <section><header><Lightbulb size={16} /><h2>关键洞察</h2></header><ol>{selected.insights.map((insight, index) => <li key={insight}><span>{String(index + 1).padStart(2, "0")}</span><div><p>{insight}</p>{project.study ? <button type="button" disabled={pending || citedInsights.includes(insight)} onClick={() => citeInsight(selected.publicId, insight)}>{citedInsights.includes(insight) ? <><Check size={11} />已引用</> : "加入研究报告"}</button> : null}</div></li>)}</ol></section>
          <section><header><Quote size={16} /><h2>合成引用</h2></header>{selected.quotes.map((quote) => <blockquote key={quote}>“{formatQuote(quote)}”</blockquote>)}</section>
          <section className="interview-links"><header><UsersRound size={16} /><h2>研究关联</h2></header>{project.panel ? <Link href={`/panel/${project.panel.publicId}`}>Panel<span>{project.panel.title}</span></Link> : null}{project.study ? <Link href={`/study/${project.study.publicId}`}>研究<span>{project.study.title}</span></Link> : null}{!project.panel && !project.study ? <p>该项目暂未关联 Panel 或研究。</p> : null}</section>
        </aside>
      </div> : null}

      {view === "questions" ? <main className="interview-analysis-view">
        <header><div><span>QUESTION ANALYSIS</span><h2>逐题分析</h2><p>横向比较每个 AI Persona 对同一访谈问题的回答。</p></div><strong>{project.questions.length} 个问题 · {project.sessionCount} 个 Persona</strong></header>
        <div className="interview-question-list">{project.questions.map((question) => <section key={question.index}><header><span>{String(question.index).padStart(2, "0")}</span><h3>{question.question}</h3></header><div>{question.answers.map((answer) => <article key={answer.personaPublicId}><strong>{answer.personaName}</strong><p>{answer.answer}</p></article>)}</div></section>)}</div>
      </main> : null}

      {view === "report" ? <main className="interview-report-view">
        <header><div><span>AI SYNTHETIC INTERVIEW REPORT</span><h2>{project.title}</h2><p>{project.objective}</p></div><button type="button" onClick={downloadMarkdown}><Download size={15} />导出完整记录</button></header>
        <dl className="interview-report-metrics"><div><dt>{project.sessionCount}</dt><dd>AI Persona</dd></div><div><dt>{project.questions.length}</dt><dd>访谈问题</dd></div><div><dt>{report.insights.length}</dt><dd>关键洞察</dd></div><div><dt>{report.quotes.length}</dt><dd>合成引用</dd></div></dl>
        <section><h3>会话摘要</h3><div className="interview-report-summaries">{report.summaries.map((item) => <article key={item.persona}><strong>{item.persona}</strong><p>{item.summary}</p></article>)}</div></section>
        <section><h3>跨会话洞察</h3><ol className="interview-report-insights">{report.insights.map((item, index) => <li key={`${item.persona}-${item.insight}`}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.persona}</strong><p>{item.insight}</p>{project.study ? <button type="button" disabled={pending || citedInsights.includes(item.insight)} onClick={() => citeInsight(item.sessionPublicId, item.insight)}>{citedInsights.includes(item.insight) ? <><Check size={12} />已加入</> : "加入研究报告"}</button> : null}</div></li>)}</ol></section>
        <section><h3>代表性合成引用</h3><div className="interview-report-quotes">{report.quotes.map((item) => <blockquote key={`${item.persona}-${item.quote}`}>“{item.quote}”<footer>AI 合成 Persona · {item.persona}</footer></blockquote>)}</div></section>
        <footer><Bot size={15} />本报告仅用于假设探索与研究设计，不代表真人样本、真实引语或统计结论。</footer>
      </main> : null}
    </div>
  );
}
