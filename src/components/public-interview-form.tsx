"use client";

/* eslint-disable @next/next/no-img-element -- respondent images use runtime Supabase public URLs */

import { ArrowLeft, ArrowRight, Bot, Check, ClipboardList, LoaderCircle, MessageCircleMore, Send, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState, useTransition } from "react";
import type { PublicInterviewInvitation } from "@/lib/interviews";
import type { PublicRealtimeInterviewState } from "@/lib/realtime-interviews";

type InterviewMode = "realtime" | "form";
type StoredRealtimeSession = { sessionPublicId: string; resumeToken: string };

function storageKey(token: string) {
  return `atypica:realtime-interview:${token}`;
}

function createIdempotencyKey() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function PublicInterviewForm({ invitation }: { invitation: PublicInterviewInvitation }) {
  const [mode, setMode] = useState<InterviewMode>("realtime");
  const [started, setStarted] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [realtime, setRealtime] = useState<PublicRealtimeInterviewState | null>(null);
  const [credentials, setCredentials] = useState<StoredRealtimeSession | null>(null);
  const [draft, setDraft] = useState("");
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const pendingTurnKey = useRef<string | null>(null);
  const question = invitation.questions[step];
  const answer = question ? answers[question.publicId] : undefined;
  const answerReady = typeof answer === "string" ? answer.trim().length > 0 : Array.isArray(answer) && answer.length > 0;

  useEffect(() => {
    const raw = window.localStorage.getItem(storageKey(invitation.token));
    if (!raw) { queueMicrotask(() => setRestoring(false)); return; }
    let stored: StoredRealtimeSession;
    try { stored = JSON.parse(raw) as StoredRealtimeSession; } catch { window.localStorage.removeItem(storageKey(invitation.token)); queueMicrotask(() => setRestoring(false)); return; }
    fetch(`/api/interview-invitations/${invitation.token}/realtime/${stored.sessionPublicId}`, {
      headers: { "x-interview-resume-token": stored.resumeToken },
    }).then(async (response) => {
      if (!response.ok) throw new Error();
      const result = await response.json() as { state: PublicRealtimeInterviewState };
      setCredentials(stored);
      setRealtime(result.state);
      setName(result.state.participantName);
      setMode("realtime");
      setStarted(true);
      setCompleted(result.state.status === "completed");
    }).catch(() => window.localStorage.removeItem(storageKey(invitation.token))).finally(() => setRestoring(false));
  }, [invitation.token]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [realtime?.messages.length, pending]);

  function toggleOption(option: string) {
    if (!question) return;
    if (question.questionType === "single") {
      setAnswers((current) => ({ ...current, [question.publicId]: option }));
      return;
    }
    setAnswers((current) => {
      const selected = Array.isArray(current[question.publicId]) ? current[question.publicId] as string[] : [];
      return { ...current, [question.publicId]: selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option] };
    });
  }

  function startInterview() {
    setError("");
    if (mode === "form") { setStarted(true); return; }
    startTransition(async () => {
      const response = await fetch(`/api/interview-invitations/${invitation.token}/realtime`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantName: name, participantEmail: email }),
      });
      const result = await response.json() as { error?: string; resumeToken?: string; state?: PublicRealtimeInterviewState };
      if (!response.ok || !result.resumeToken || !result.state) {
        setError(result.error ?? "暂时无法开始 Agent 访谈");
        return;
      }
      const stored = { sessionPublicId: result.state.sessionPublicId, resumeToken: result.resumeToken };
      window.localStorage.setItem(storageKey(invitation.token), JSON.stringify(stored));
      setCredentials(stored);
      setRealtime(result.state);
      setStarted(true);
    });
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    startTransition(async () => {
      const response = await fetch(`/api/interview-invitations/${invitation.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantName: name, participantEmail: email, answers: invitation.questions.map((item) => ({ questionPublicId: item.publicId, answer: answers[item.publicId] })) }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error ?? "暂时无法提交访谈"); return; }
      setCompleted(true);
    });
  }

  function submitRealtimeTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !credentials || !realtime) return;
    setDraft(""); setError("");
    startTransition(async () => {
      const idempotencyKey = pendingTurnKey.current ?? createIdempotencyKey();
      pendingTurnKey.current = idempotencyKey;
      const response = await fetch(`/api/interview-invitations/${invitation.token}/realtime/${realtime.sessionPublicId}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-interview-resume-token": credentials.resumeToken },
        body: JSON.stringify({ content, idempotencyKey }),
      });
      const result = await response.json() as { error?: string; state?: PublicRealtimeInterviewState };
      if (!response.ok || !result.state) { setDraft(content); setError(result.error ?? "Agent 暂时无法继续，请重试"); return; }
      pendingTurnKey.current = null;
      setRealtime(result.state);
      if (result.state.status === "completed") setCompleted(true);
    });
  }

  function cancelRealtime() {
    if (!credentials || !realtime) return;
    startTransition(async () => {
      const response = await fetch(`/api/interview-invitations/${invitation.token}/realtime/${realtime.sessionPublicId}`, {
        method: "DELETE",
        headers: { "x-interview-resume-token": credentials.resumeToken },
      });
      if (response.ok) {
        const result = await response.json() as { state: PublicRealtimeInterviewState };
        setRealtime(result.state);
        window.localStorage.removeItem(storageKey(invitation.token));
      }
    });
  }

  if (restoring) return <main className="public-interview-shell"><LoaderCircle className="spin" size={24} /></main>;

  if (completed) return <main className="public-interview-shell"><section className="public-interview-complete"><span><Check size={24} /></span><h1>访谈已完成</h1><p>感谢你的时间。回答已经安全提交给研究团队。</p></section></main>;

  if (!started) return <main className="public-interview-shell"><section className="public-interview-intro">
    <div className="public-interview-brand">Cognara AI <span>INTERVIEW</span></div>
    <span className="public-interview-icon">{mode === "realtime" ? <MessageCircleMore size={23} /> : <ClipboardList size={23} />}</span><h1>{invitation.projectTitle}</h1><p>{invitation.objective}</p>
    <div className="public-interview-mode" role="group" aria-label="访谈方式"><button className={mode === "realtime" ? "active" : ""} type="button" onClick={() => { setMode("realtime"); setError(""); }}><Bot size={15} />Agent 对话</button><button className={mode === "form" ? "active" : ""} type="button" onClick={() => { setMode("form"); setError(""); }}><ClipboardList size={15} />传统问卷</button></div>
    <dl><div><dt>{invitation.questions.length}</dt><dd>个核心问题</dd></div><div><dt>约 {Math.max(3, invitation.questions.length * (mode === "realtime" ? 3 : 2))}</dt><dd>分钟</dd></div></dl>
    <div className="public-interview-identity"><label>你的称呼<input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required placeholder="例如：王女士" /></label><label>邮箱（可选）<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="用于研究团队后续联系" /></label></div>
    {error ? <p className="public-interview-error" role="alert">{error}</p> : null}
    <button type="button" disabled={pending || name.trim().length < 2 || invitation.questions.length === 0} onClick={startInterview}>{pending ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{pending ? "正在准备" : mode === "realtime" ? "开始 Agent 访谈" : "开始填写"}</button>
    <small>提交即表示你同意研究团队将回答用于本项目分析。</small>
  </section></main>;

  if (mode === "realtime" && realtime) return <main className="public-interview-shell public-realtime-shell"><section className="public-realtime-interview">
    <header><div className="public-interview-brand">Cognara AI <span>AGENT INTERVIEW</span></div><div><span>{Math.min(realtime.currentQuestionPosition, realtime.questionCount)} / {realtime.questionCount}</span><button type="button" disabled={pending} onClick={cancelRealtime} title="结束访谈" aria-label="结束访谈"><X size={15} /></button></div></header>
    <div className="public-interview-progress"><i style={{ width: `${Math.min(100, (realtime.currentQuestionPosition / realtime.questionCount) * 100)}%` }} /></div>
    <section className="public-realtime-transcript" aria-live="polite">{realtime.messages.map((message) => <article className={message.role} key={message.publicId}><div>{message.role === "agent" ? <Bot size={15} /> : realtime.participantName.slice(0, 1)}</div><section><strong>{message.role === "agent" ? "访谈 Agent" : realtime.participantName}</strong><p>{message.content}</p></section></article>)}{pending ? <article className="agent pending"><div><LoaderCircle className="spin" size={15} /></div><section><strong>访谈 Agent</strong><p>正在结合你的回答决定下一步...</p></section></article> : null}<div ref={transcriptEnd} /></section>
    {realtime.status === "cancelled" ? <footer className="public-realtime-ended"><p>本次访谈已结束，已提交的回答仍会保留。</p></footer> : <form onSubmit={submitRealtimeTurn}><textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} disabled={pending} maxLength={4000} placeholder="分享你的真实经历和想法..." /><button type="submit" disabled={pending || !draft.trim()} title="发送回答" aria-label="发送回答">{pending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></form>}
    {error ? <p className="public-interview-error" role="alert">{error}</p> : null}
  </section></main>;

  return <main className="public-interview-shell"><form className="public-interview-question" onSubmit={submitForm}>
    <header><div className="public-interview-brand">Cognara AI <span>INTERVIEW</span></div><strong>{step + 1} / {invitation.questions.length}</strong></header>
    <div className="public-interview-progress"><i style={{ width: `${((step + 1) / invitation.questions.length) * 100}%` }} /></div>
    <section><span>QUESTION {String(step + 1).padStart(2, "0")}</span><h1>{question.content}</h1>{question.imageUrls.length > 0 ? <div className={`public-interview-images count-${question.imageUrls.length}`}>{question.imageUrls.map((url, index) => <img key={url} src={url} alt={`问题参考图 ${index + 1}`} />)}</div> : null}
      {question.questionType === "open" ? <textarea autoFocus value={typeof answer === "string" ? answer : ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.publicId]: event.target.value }))} required minLength={1} maxLength={4000} placeholder="请分享你的真实经历和想法..." /> : <div className="public-interview-options">{question.options.map((option) => { const selected = typeof answer === "string" ? answer === option : Array.isArray(answer) && answer.includes(option); return <button type="button" className={selected ? "selected" : ""} onClick={() => toggleOption(option)} key={option}><i>{selected ? <Check size={14} /> : null}</i>{option}</button>; })}</div>}
    </section>
    {error ? <p className="public-interview-error" role="alert">{error}</p> : null}
    <footer><button type="button" disabled={step === 0 || pending} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={15} />上一题</button>{step < invitation.questions.length - 1 ? <button className="primary" type="button" disabled={!answerReady} onClick={() => setStep((current) => current + 1)}>下一题<ArrowRight size={15} /></button> : <button className="primary" type="submit" disabled={!answerReady || pending}>{pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{pending ? "提交中" : "完成访谈"}</button>}</footer>
  </form></main>;
}
