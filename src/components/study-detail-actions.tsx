"use client";

import { Check, ChevronDown, LoaderCircle, Pencil, RotateCcw, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { StudyDetail } from "@/lib/studies";
import type { StudyMethod } from "@/lib/research-types";

const availableMethods: StudyMethod[] = ["Scout Agent", "Fast Insight", "Interview Chat", "Discussion Chat"];

export function StudyDetailActions({ publicId, plan }: { publicId: string; plan: StudyDetail["plan"] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState(() => ({
    framework: plan.framework,
    methods: plan.methods,
    audience: plan.personaFilters.audience,
    source: plan.personaFilters.source,
    personaCount: plan.personaCount,
    estimatedDurationMinutes: plan.estimatedDurationMinutes,
    estimatedTokens: plan.estimatedTokens,
    rationale: plan.rationale,
  }));

  function confirmPlan() {
    setError("");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/studies/${publicId}/confirm`, { method: "POST" });
        const result = (await response.json()) as { error?: string };

        if (!response.ok) {
          setError(result.error ?? "暂时无法确认计划");
          return;
        }

        router.refresh();
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  function revisePlan() {
    setError("");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/studies/${publicId}/plan`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...draft, feedback: feedback.trim() || undefined }),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) {
          setError(result.error ?? "暂时无法更新研究计划");
          return;
        }
        setEditing(false);
        setFeedback("");
        router.refresh();
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  function toggleMethod(method: StudyMethod) {
    setDraft((current) => ({
      ...current,
      methods: current.methods.includes(method)
        ? current.methods.filter((item) => item !== method)
        : [...current.methods, method],
    }));
  }

  return (
    <div className="plan-actions-wrap">
      {editing ? (
        <div className="plan-editor" aria-label="编辑研究计划">
          <div className="plan-editor-heading"><div><strong>调整研究计划</strong><span>保存后会生成新的草案版本，确认前都可以继续修改。</span></div><button type="button" className="plan-editor-close" onClick={() => setEditing(false)} aria-label="收起编辑"><ChevronDown size={16} /></button></div>
          <label>研究框架<input value={draft.framework} onChange={(event) => setDraft({ ...draft, framework: event.target.value })} /></label>
          <label>目标人群 / 市场范围<textarea rows={2} value={draft.audience} onChange={(event) => setDraft({ ...draft, audience: event.target.value })} /></label>
          <label>证据范围<textarea rows={2} value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label>
          <fieldset><legend>研究方法</legend><div className="plan-method-options">{availableMethods.map((method) => <button type="button" key={method} className={draft.methods.includes(method) ? "selected" : ""} onClick={() => toggleMethod(method)}>{draft.methods.includes(method) ? <Check size={13} /> : <span />}{method}</button>)}</div></fieldset>
          <div className="plan-editor-numbers"><label>Persona 数量<input type="number" min={1} max={20} value={draft.personaCount} onChange={(event) => setDraft({ ...draft, personaCount: Number(event.target.value) })} /></label><label>预计周期（分钟）<input type="number" min={30} max={4320} value={draft.estimatedDurationMinutes} onChange={(event) => setDraft({ ...draft, estimatedDurationMinutes: Number(event.target.value) })} /></label><label>预计 Token<input type="number" min={10000} max={250000} value={draft.estimatedTokens} onChange={(event) => setDraft({ ...draft, estimatedTokens: Number(event.target.value) })} /></label></div>
          <label>研究目标与说明<textarea rows={4} value={draft.rationale} onChange={(event) => setDraft({ ...draft, rationale: event.target.value })} /></label>
          <label>返修意见（可选）<textarea rows={2} placeholder="例如：增加二线城市用户，并优先关注价格敏感度" value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label>
          <div className="plan-editor-actions"><button type="button" className="button button-muted" onClick={() => setEditing(false)}>取消</button><button type="button" className="button button-green" onClick={revisePlan} disabled={pending || draft.methods.length === 0}>{pending ? <LoaderCircle className="spin" size={16} /> : <Send size={15} />}{pending ? "正在保存" : "保存并生成新草案"}</button></div>
        </div>
      ) : <>
        <div className="plan-actions plan-actions-secondary"><button className="button button-muted" type="button" onClick={() => setEditing(true)} disabled={pending}><Pencil size={15} />手动修改</button><button className="button button-muted" type="button" onClick={() => { setEditing(true); setFeedback("请根据我的意见返修研究计划："); }} disabled={pending}><RotateCcw size={15} />提出返修</button></div>
        <div className="plan-actions"><button data-study-plan-confirm className="button button-green" type="button" onClick={confirmPlan} disabled={pending}>{pending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{pending ? "正在确认" : "确认并锁定计划"}</button></div>
      </>}
      {error ? <p className="workspace-inline-error" role="alert">{error}</p> : null}
    </div>
  );
}
