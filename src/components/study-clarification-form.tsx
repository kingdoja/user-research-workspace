"use client";

import { Check, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ClarificationAnswer, ClarificationQuestion } from "@/lib/studies";

export function StudyClarificationForm({
  publicId,
  questions,
}: {
  publicId: string;
  questions: ClarificationQuestion[];
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const complete = questions.every((question) => (answers[question.id]?.length ?? 0) >= 1);

  function select(question: ClarificationQuestion, option: string) {
    setAnswers((current) => {
      const selected = current[question.id] ?? [];
      const next = question.maxSelect === 1
        ? [option]
        : selected.includes(option)
          ? selected.filter((item) => item !== option)
          : selected.length < question.maxSelect ? [...selected, option] : selected;
      return { ...current, [question.id]: next };
    });
  }

  function submit() {
    if (!complete) return;
    setError("");
    const payload: ClarificationAnswer[] = questions.map((question) => ({
      questionId: question.id,
      selected: answers[question.id] ?? [],
    }));

    startTransition(async () => {
      try {
        const response = await fetch(`/api/studies/${publicId}/clarify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: payload }),
        });
        const result = (await response.json()) as { error?: string };
        if (!response.ok) {
          setError(result.error ?? "暂时无法提交澄清答案");
          return;
        }
        router.refresh();
      } catch {
        setError("网络连接失败，请稍后重试");
      }
    });
  }

  return (
    <div className="agent-clarification-form">
      {questions.map((question) => (
        <fieldset key={question.id}>
          <legend><span>{question.label}</span>{question.question}<small>{question.maxSelect > 1 ? `最多选择 ${question.maxSelect} 项` : "单选"}</small></legend>
          <div className="clarification-options">
            {question.options.map((option) => {
              const selected = answers[question.id]?.includes(option) ?? false;
              return (
                <button type="button" className={selected ? "selected" : ""} onClick={() => select(question, option)} key={option} aria-pressed={selected}>
                  <span>{selected ? <Check size={13} /> : null}</span>{option}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <button type="button" className="clarification-submit" disabled={!complete || pending} onClick={submit}>
        {pending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
        {pending ? "正在生成研究计划" : "提交答案并生成计划"}
      </button>
      {error ? <p className="workspace-inline-error" role="alert">{error}</p> : null}
    </div>
  );
}
