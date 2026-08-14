"use client";

import { Check, ChevronDown, ClipboardCheck, Database, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useState, useTransition } from "react";

type Replay = {
  workflow: { type: string; version: string; status: string };
  skill: { slug: string; version: number | null } | null;
  strategy: { key: string; version: string };
  context: { retrievalPublicId: string; strategy: string; citations: Array<{ rank: number; title: string; version: number }> } | null;
  messages: Array<{ public_id: string; turn_index: number; message_type: string; provider_response_id: string | null; prompt_version: string | null }>;
  reviews: Array<{ overall_score: number; reviewer_name: string; updated_at: string }>;
};

const dimensions = [
  ["relevance", "相关性"],
  ["depth", "深度"],
  ["followupQuality", "追问质量"],
  ["consistency", "一致性"],
  ["evidenceGrounding", "证据约束"],
  ["safetyCompliance", "安全合规"],
] as const;

export function InterviewSessionEvaluation({ projectPublicId, sessionPublicId, workflowType }: {
  projectPublicId: string;
  sessionPublicId: string;
  workflowType: string;
}) {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [scores, setScores] = useState<Record<(typeof dimensions)[number][0], number>>({
    relevance: 3, depth: 3, followupQuality: 3, consistency: 3, evidenceGrounding: 3, safetyCompliance: 3,
  });
  const [notes, setNotes] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    fetch(`/api/interviews/${projectPublicId}/sessions/${sessionPublicId}/replay`)
      .then(async (response) => response.ok ? (await response.json() as { replay: Replay }).replay : null)
      .then(setReplay).catch(() => setReplay(null));
  }, [projectPublicId, sessionPublicId]);

  function submitReview() {
    setNotice("");
    startTransition(async () => {
      const response = await fetch(`/api/interviews/${projectPublicId}/sessions/${sessionPublicId}/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...scores, notes }),
      });
      const result = await response.json() as { error?: string; review?: { overallScore: number } };
      setNotice(response.ok ? `已记录，综合评分 ${result.review?.overallScore.toFixed(1)}` : result.error ?? "评分保存失败");
    });
  }

  return <section className="interview-session-evaluation">
    <header><ClipboardCheck size={16} /><h2>质量评估</h2></header>
    {workflowType === "realtime_agent" ? <details open>
      <summary><Database size={13} /><span>版本回放</span><ChevronDown size={13} /></summary>
      {replay ? <dl className="interview-replay-meta"><div><dt>Workflow</dt><dd>{replay.workflow.version}</dd></div><div><dt>Skill</dt><dd>{replay.skill ? `${replay.skill.slug}@${replay.skill.version}` : "未绑定"}</dd></div><div><dt>Strategy</dt><dd>{replay.strategy.key} / {replay.strategy.version}</dd></div><div><dt>Context</dt><dd>{replay.context ? `${replay.context.retrievalPublicId} · ${replay.context.citations.length} 条` : "无命中"}</dd></div><div><dt>Provider turns</dt><dd>{replay.messages.filter((message) => message.provider_response_id).length}</dd></div><div><dt>人工评分</dt><dd>{replay.reviews.length ? `${Number(replay.reviews[0].overall_score).toFixed(1)} / 5` : "未评分"}</dd></div></dl> : <p>正在读取回放元数据...</p>}
    </details> : <p>静态问卷和批量合成会话保留原始消息，不包含逐轮 Agent 策略回放。</p>}
    <div className="interview-review-grid">{dimensions.map(([key, label]) => <label key={key}><span>{label}<strong>{scores[key]}</strong></span><input type="range" min="1" max="5" step="1" value={scores[key]} onChange={(event) => setScores((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>)}</div>
    <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} placeholder="记录值得保留或需要修正的访谈行为（可选）" />
    <button type="button" disabled={pending} onClick={submitReview}>{pending ? <LoaderCircle className="spin" size={13} /> : notice ? <RotateCcw size={13} /> : <Check size={13} />}{pending ? "保存中" : notice ? "更新评分" : "保存评分"}</button>
    {notice ? <small>{notice}</small> : null}
  </section>;
}
