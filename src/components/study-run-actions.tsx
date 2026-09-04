"use client";

import { LoaderCircle, Play, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export function StudyRunActions({
  publicId,
  configured,
  retry,
  autonomousRecovery = false,
}: {
  publicId: string;
  configured: boolean;
  retry: boolean;
  autonomousRecovery?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const actionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => actionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return () => window.clearTimeout(timer);
  }, []);

  function startRun() {
    setError("");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/studies/${publicId}/run`, { method: "POST" });
        const result = (await response.json()) as { error?: string };

        if (!response.ok) {
          setError(result.error ?? "暂时无法启动研究");
          return;
        }

        router.refresh();
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  return (
    <div className="run-actions" ref={actionRef}>
      <button
        className="button button-green"
        type="button"
        onClick={startRun}
        disabled={pending || !configured}
        title={configured ? (autonomousRecovery ? "自动扩展公开网页检索并继续" : retry ? "重新执行研究" : "启动研究") : "服务器需要 OPENAI_API_KEY"}
      >
        {pending
          ? <LoaderCircle className="spin" size={17} />
          : retry
            ? <RotateCcw size={17} />
            : <Play size={17} />}
        {pending ? "正在排队" : autonomousRecovery ? "自动补充资料并继续" : retry ? "重新执行" : configured ? "启动公开网页研究" : "等待 API Key"}
      </button>
      {error ? <p className="workspace-inline-error" role="alert">{error}</p> : null}
    </div>
  );
}
