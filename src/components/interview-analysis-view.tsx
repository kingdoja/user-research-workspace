"use client";

import { Bot, Check, ChevronRight, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import type { InterviewProjectDetail } from "@/lib/interviews";
import { getInterviewSourceCounts, getQuestionCoverage, type InterviewSourceFilter } from "@/lib/interview-analysis";

const sourceLabels: Record<InterviewSourceFilter, string> = { all: "全部", ai: "AI Persona", human: "真人" };

export function InterviewAnalysisView({ project }: { project: InterviewProjectDetail }) {
  const [source, setSource] = useState<InterviewSourceFilter>("all");
  const [selectedQuestionId, setSelectedQuestionId] = useState(project.questions[0]?.publicId ?? "");
  const counts = useMemo(() => getInterviewSourceCounts(project), [project]);
  const coverage = useMemo(() => getQuestionCoverage(project, source), [project, source]);
  const selected = project.questions.find((question) => question.publicId === selectedQuestionId) ?? project.questions[0];
  const answers = selected?.answers.filter((answer) => source === "all" || answer.sessionType === source) ?? [];
  const selectedCoverage = coverage.find((item) => item.questionPublicId === selected?.publicId);

  if (!selected) return <main className="interview-analysis-empty"><h2>还没有可分析的问题</h2><p>生成 AI 访谈或在配置页添加问题后，这里会显示逐题回答对比。</p></main>;

  return <main className="interview-analysis-workspace">
    <header className="interview-analysis-header"><div><span>QUESTION ANALYSIS</span><h2>逐题分析</h2><p>按来源筛选回答，比较参与者在同一问题下的关注重点。</p></div><div className="interview-source-filter" aria-label="回答来源筛选">{(["all", "ai", "human"] as const).map((value) => <button className={source === value ? "active" : ""} type="button" onClick={() => setSource(value)} key={value}>{value === "ai" ? <Bot size={13} /> : value === "human" ? <UserRound size={13} /> : null}{sourceLabels[value]}<span>{counts[value]}</span></button>)}</div></header>
    <div className="interview-analysis-grid">
      <aside><header><span>问题</span><strong>{project.questions.length}</strong></header><nav>{project.questions.map((question, index) => { const itemCoverage = coverage[index]; return <button className={question.publicId === selected.publicId ? "active" : ""} type="button" onClick={() => setSelectedQuestionId(question.publicId)} key={question.publicId}><i>{String(question.index).padStart(2, "0")}</i><span><strong>{question.question}</strong><small>{itemCoverage.answerCount} / {itemCoverage.sessionCount} 份回答</small></span><ChevronRight size={13} /></button>; })}</nav></aside>
      <section className="interview-answer-comparison"><header><div><span>QUESTION {String(selected.index).padStart(2, "0")}</span><h3>{selected.question}</h3></div><strong>{selectedCoverage?.answerCount ?? 0} / {selectedCoverage?.sessionCount ?? 0} 已回答</strong></header>
        <div className="interview-coverage-bar" aria-label="回答覆盖率"><i style={{ width: `${selectedCoverage?.sessionCount ? (selectedCoverage.answerCount / selectedCoverage.sessionCount) * 100 : 0}%` }} /></div>
        {answers.length ? <div className="interview-answer-grid">{answers.map((answer) => <article key={answer.sessionPublicId}><header><div>{answer.sessionType === "ai" ? <Bot size={14} /> : <UserRound size={14} />}</div><span><strong>{answer.personaName}</strong><small>{answer.sessionType === "ai" ? "AI 合成 Persona" : "真人参与者"}</small></span>{answer.answer.trim() ? <Check size={13} /> : null}</header><p>{answer.answer}</p></article>)}</div> : <div className="interview-analysis-empty compact"><h3>当前筛选下没有回答</h3><p>切换回答来源，或等待更多参与者完成访谈。</p></div>}
      </section>
    </div>
  </main>;
}
