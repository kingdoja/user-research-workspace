"use client";

import { ArrowUpRight, Bot, Check, Download, FlaskConical, GitCompareArrows, Lightbulb, Quote, UserRound } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import type { InterviewProjectDetail } from "@/lib/interviews";
import { buildInterviewDifferences, buildInterviewHypotheses, buildInterviewThemes } from "@/lib/interview-analysis";

function formatQuote(value: string) {
  return value.replace(/^[“”"']+|[“”"']+$/g, "").trim();
}

export function InterviewReportView({ project, onDownload, onOpenSession }: { project: InterviewProjectDetail; onDownload: () => void; onOpenSession: (sessionPublicId: string) => void }) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cited, setCited] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const themes = useMemo(() => buildInterviewThemes(project), [project]);
  const differences = useMemo(() => buildInterviewDifferences(project), [project]);
  const hypotheses = useMemo(() => buildInterviewHypotheses(themes), [themes]);
  const aiCount = project.sessions.filter((session) => session.sessionType === "ai").length;
  const humanCount = project.sessions.filter((session) => session.sessionType === "human").length;
  const quotes = project.sessions.flatMap((session) => session.quotes.map((quote) => ({
    sessionPublicId: session.publicId,
    participantName: session.participantName,
    sessionType: session.sessionType,
    quote: formatQuote(quote),
  }))).slice(0, 6);

  function citeInsight(sessionPublicId: string, insight: string, id: string) {
    setError(""); setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${project.publicId}/insights`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionPublicId, insight, attribution: "synthesis" }),
      });
      const result = await response.json() as { error?: string; duplicate?: boolean };
      if (!response.ok) { setError(result.error ?? "暂时无法引用该洞察"); return; }
      setCited((current) => [...current, id]);
      setNotice(result.duplicate ? "该洞察已存在于研究报告中" : "洞察已加入关联研究报告");
    });
  }

  return <main className="interview-report-view enhanced">
    <header><div><span>INTERVIEW SYNTHESIS REPORT</span><h2>{project.title}</h2><p>{project.objective}</p></div><button type="button" onClick={onDownload}><Download size={15} />导出完整记录</button></header>
    {error || notice ? <div className={error ? "interview-report-notice error" : "interview-report-notice"} role={error ? "alert" : "status"}>{error || notice}</div> : null}
    <dl className="interview-report-metrics"><div><dt>{project.sessionCount}</dt><dd>访谈会话</dd></div><div><dt>{aiCount}</dt><dd>AI Persona</dd></div><div><dt>{humanCount}</dt><dd>真人参与者</dd></div><div><dt>{themes.length}</dt><dd>归纳主题</dd></div></dl>
    <section className="interview-report-overview"><header><div><Lightbulb size={16} /><h3>主题与证据</h3></div><p>从已有会话洞察中归类；每条主题均可回到参与者记录。</p></header>{themes.length ? <div className="interview-theme-list">{themes.map((theme, index) => <article key={theme.id}><header><span>{String(index + 1).padStart(2, "0")}</span><div><h4>{theme.label}</h4><p>{theme.insight}</p></div><strong>{theme.participantNames.length} 位参与者</strong></header><div className="interview-theme-evidence">{theme.evidence.slice(0, 3).map((evidence) => <blockquote key={`${evidence.sessionPublicId}-${evidence.text}`}><span>{evidence.sessionType === "ai" ? <Bot size={12} /> : <UserRound size={12} />}{evidence.participantName}</span><p>{evidence.text}</p><button className="interview-evidence-link" type="button" onClick={() => onOpenSession(evidence.sessionPublicId)}><ArrowUpRight size={11} />查看原始访谈</button></blockquote>)}</div>{project.study ? <button type="button" disabled={pending || cited.includes(theme.id)} onClick={() => citeInsight(theme.sessionPublicId, theme.insight, theme.id)}>{cited.includes(theme.id) ? <><Check size={12} />已加入研究报告</> : "引用到研究报告"}</button> : null}</article>)}</div> : <p className="interview-report-empty">当前会话尚未形成结构化洞察。</p>}</section>
    <section><header className="interview-report-section-heading"><div><GitCompareArrows size={16} /><h3>关注差异</h3></div><p>同一问题下不同参与者的回答并列展示；差异不等同于观点冲突。</p></header>{differences.length ? <div className="interview-difference-list">{differences.slice(0, 4).map((difference) => <article key={difference.questionPublicId}><h4>{difference.question}</h4><div>{difference.answers.map((answer) => <blockquote key={`${answer.sessionPublicId}-${answer.excerpt}`}><strong>{answer.participantName}<span>{answer.sessionType === "ai" ? "AI" : "真人"}</span></strong><p>{answer.excerpt}</p><button className="interview-evidence-link" type="button" onClick={() => onOpenSession(answer.sessionPublicId)}><ArrowUpRight size={11} />查看原始访谈</button></blockquote>)}</div></article>)}</div> : <p className="interview-report-empty">至少需要两位参与者回答同一问题，才能比较关注差异。</p>}</section>
    <section><header className="interview-report-section-heading"><div><FlaskConical size={16} /><h3>待验证假设</h3></div><p>这些结论是研究线索，不代表总体规律。</p></header><ol className="interview-hypothesis-list">{hypotheses.map((hypothesis, index) => <li key={hypothesis.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{hypothesis.statement}</strong><p>{hypothesis.validation}</p>{project.study ? <button type="button" disabled={pending || cited.includes(`hypothesis-${hypothesis.id}`)} onClick={() => citeInsight(hypothesis.sessionPublicId, hypothesis.statement, `hypothesis-${hypothesis.id}`)}>{cited.includes(`hypothesis-${hypothesis.id}`) ? <><Check size={12} />已加入研究报告</> : "引用为待验证假设"}</button> : null}</div></li>)}</ol></section>
    <section><header className="interview-report-section-heading"><div><Quote size={16} /><h3>代表性表达</h3></div><p>AI 会话为合成表达，真人会话为单场访谈记录。</p></header><div className="interview-report-quotes">{quotes.map((item) => <blockquote key={`${item.sessionPublicId}-${item.quote}`}>“{item.quote}”<footer>{item.sessionType === "ai" ? "AI 合成 Persona" : "真人参与者"} · {item.participantName}</footer></blockquote>)}</div></section>
    <footer><Bot size={15} />本报告用于归纳已记录的访谈材料。AI 合成内容不代表真人陈述，少量真人会话也不构成统计结论。</footer>
  </main>;
}
