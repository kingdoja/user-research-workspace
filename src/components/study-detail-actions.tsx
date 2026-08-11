"use client";

import { Check, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function StudyDetailActions({ publicId }: { publicId: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

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

  return (
    <div className="plan-actions">
      <button className="button button-green" type="button" onClick={confirmPlan} disabled={pending}>
        {pending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
        {pending ? "正在确认" : "确认并锁定计划"}
      </button>
      {error ? <p className="workspace-inline-error" role="alert">{error}</p> : null}
    </div>
  );
}
