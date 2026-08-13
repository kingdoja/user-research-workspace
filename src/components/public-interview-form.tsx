"use client";

/* eslint-disable @next/next/no-img-element -- respondent images use runtime Supabase public URLs */

import { ArrowLeft, ArrowRight, Check, ClipboardList, LoaderCircle } from "lucide-react";
import { FormEvent, useState, useTransition } from "react";
import type { PublicInterviewInvitation } from "@/lib/interviews";

export function PublicInterviewForm({ invitation }: { invitation: PublicInterviewInvitation }) {
  const [started, setStarted] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const question = invitation.questions[step];
  const answer = question ? answers[question.publicId] : undefined;
  const answerReady = typeof answer === "string" ? answer.trim().length > 0 : Array.isArray(answer) && answer.length > 0;

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

  function submit(event: FormEvent<HTMLFormElement>) {
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

  if (completed) return <main className="public-interview-shell"><section className="public-interview-complete"><span><Check size={24} /></span><h1>访谈已完成</h1><p>感谢你的时间。回答已经安全提交给研究团队。</p></section></main>;

  if (!started) return <main className="public-interview-shell"><section className="public-interview-intro">
    <div className="public-interview-brand">atypica.AI <span>INTERVIEW</span></div>
    <span className="public-interview-icon"><ClipboardList size={23} /></span><h1>{invitation.projectTitle}</h1><p>{invitation.objective}</p>
    <dl><div><dt>{invitation.questions.length}</dt><dd>个问题</dd></div><div><dt>约 {Math.max(3, invitation.questions.length * 2)}</dt><dd>分钟</dd></div></dl>
    <div className="public-interview-identity"><label>你的称呼<input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required placeholder="例如：王女士" /></label><label>邮箱（可选）<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="用于研究团队后续联系" /></label></div>
    <button type="button" disabled={name.trim().length < 2 || invitation.questions.length === 0} onClick={() => setStarted(true)}>开始访谈<ArrowRight size={16} /></button>
    <small>提交即表示你同意研究团队将回答用于本项目分析。</small>
  </section></main>;

  return <main className="public-interview-shell"><form className="public-interview-question" onSubmit={submit}>
    <header><div className="public-interview-brand">atypica.AI <span>INTERVIEW</span></div><strong>{step + 1} / {invitation.questions.length}</strong></header>
    <div className="public-interview-progress"><i style={{ width: `${((step + 1) / invitation.questions.length) * 100}%` }} /></div>
    <section><span>QUESTION {String(step + 1).padStart(2, "0")}</span><h1>{question.content}</h1>{question.imageUrls.length > 0 ? <div className={`public-interview-images count-${question.imageUrls.length}`}>{question.imageUrls.map((url, index) => <img key={url} src={url} alt={`问题参考图 ${index + 1}`} />)}</div> : null}
      {question.questionType === "open" ? <textarea autoFocus value={typeof answer === "string" ? answer : ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.publicId]: event.target.value }))} required minLength={1} maxLength={4000} placeholder="请分享你的真实经历和想法..." /> : <div className="public-interview-options">{question.options.map((option) => { const selected = typeof answer === "string" ? answer === option : Array.isArray(answer) && answer.includes(option); return <button type="button" className={selected ? "selected" : ""} onClick={() => toggleOption(option)} key={option}><i>{selected ? <Check size={14} /> : null}</i>{option}</button>; })}</div>}
    </section>
    {error ? <p className="public-interview-error" role="alert">{error}</p> : null}
    <footer><button type="button" disabled={step === 0 || pending} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={15} />上一题</button>{step < invitation.questions.length - 1 ? <button className="primary" type="button" disabled={!answerReady} onClick={() => setStep((current) => current + 1)}>下一题<ArrowRight size={15} /></button> : <button className="primary" type="submit" disabled={!answerReady || pending}>{pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{pending ? "提交中" : "完成访谈"}</button>}</footer>
  </form></main>;
}
