"use client";

import { ArrowUp, ListChecks, LoaderCircle, Paperclip, Plus, UsersRound, Workflow } from "lucide-react";
import { FormEvent, useState, useTransition } from "react";

export function StudyAgentControls({
  completedSteps,
  totalSteps,
  outputCount,
}: {
  completedSteps: number;
  totalSteps: number;
  outputCount: number;
}) {
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function submitStudy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = brief.trim();
    if (normalized.length < 12) return;
    setError("");

    startTransition(async () => {
      try {
        const response = await fetch("/api/studies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brief: normalized }),
        });
        const result = (await response.json()) as { error?: string; redirectTo?: string };

        if (!response.ok || !result.redirectTo) {
          setError(result.error ?? "暂时无法开始新研究");
          return;
        }

        window.location.assign(result.redirectTo);
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  return (
    <div className="agent-workspace-controls">
      <nav className="agent-status-tabs" aria-label="研究状态">
        <button type="button" onClick={() => scrollTo("agent-progress")}>
          <ListChecks size={17} />进度 <strong>{completedSteps}/{totalSteps}</strong><span>›</span>
        </button>
        <button type="button" onClick={() => scrollTo("research-output")}>
          <Workflow size={17} />研究产出 <strong>{outputCount}</strong><span>›</span>
        </button>
        <button type="button" disabled title="当前研究未执行 Persona Panel">
          <UsersRound size={17} />Panel <strong>0</strong><span>›</span>
        </button>
      </nav>
      <form className="agent-followup-composer" onSubmit={submitStudy}>
        <textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="提出后续问题或开始一项新研究"
          maxLength={4000}
          aria-label="后续研究问题"
        />
        <div className="agent-composer-actions">
          <button type="button" className="agent-new-study" onClick={() => setBrief("")}>
            <Plus size={15} />开始新研究
          </button>
          <button type="button" className="agent-attach" disabled title="附件功能尚未开放">
            <Paperclip size={17} /><span className="sr-only">添加附件</span>
          </button>
          <button className="agent-send" type="submit" disabled={pending || brief.trim().length < 12}>
            {pending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={18} />}
            <span className="sr-only">提交</span>
          </button>
        </div>
      </form>
      {error ? <p className="agent-composer-error" role="alert">{error}</p> : null}
    </div>
  );
}
