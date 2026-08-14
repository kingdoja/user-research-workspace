"use client";

import { LoaderCircle, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function StudyTaskInputForm({
  studyPublicId,
  taskPublicId,
  request,
}: {
  studyPublicId: string;
  taskPublicId: string;
  request: Record<string, unknown>;
}) {
  const router = useRouter();
  const [focus, setFocus] = useState("");
  const [sourceUrls, setSourceUrls] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const title = typeof request.title === "string" ? request.title : "需要补充输入";
  const description = typeof request.description === "string" ? request.description : "补充信息后将从当前 checkpoint 继续。";

  function submit() {
    setError("");
    const urls = sourceUrls.split(/\n|,/).map((url) => url.trim()).filter(Boolean);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/studies/${studyPublicId}/tasks/${taskPublicId}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ focus: focus.trim() || undefined, sourceUrls: urls.length ? urls : undefined }),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) {
          setError(result.error ?? "暂时无法继续研究");
          return;
        }
        router.refresh();
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  return (
    <section className="agent-task-input" aria-label={title}>
      <header><strong>{title}</strong><span>checkpoint 已保留</span></header>
      <p>{description}</p>
      <label>补充研究焦点<textarea value={focus} maxLength={600} onChange={(event) => setFocus(event.target.value)} placeholder="例如：聚焦北京 2025 年家庭通勤场景" /></label>
      <label>可信公开 URL<textarea value={sourceUrls} onChange={(event) => setSourceUrls(event.target.value)} placeholder="每行一个 https:// URL" /></label>
      <button type="button" onClick={submit} disabled={pending}>
        {pending ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
        {pending ? "正在继续" : "提交并继续"}
      </button>
      {error ? <small role="alert">{error}</small> : null}
    </section>
  );
}
