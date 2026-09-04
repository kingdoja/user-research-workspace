"use client";

import { LoaderCircle, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { parseTaskInputRequest, validateTaskInputResponse } from "@/lib/task-input-contract";

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
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLElement>(null);
  const inputRequest = parseTaskInputRequest(request);
  const title = inputRequest?.title ?? "需要补充输入";
  const description = inputRequest?.description ?? "补充信息后将从当前 checkpoint 继续。";

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return () => window.clearTimeout(timer);
  }, []);

  function update(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    setError("");
    if (!inputRequest) {
      setError("输入字段定义无效，请刷新后重试");
      return;
    }
    const candidate = Object.fromEntries(inputRequest.fields.map((field) => [
      field.key,
      field.type === "url_list"
        ? (values[field.key] ?? "").split(/\n|,/).map((item) => item.trim()).filter(Boolean)
        : values[field.key] ?? "",
    ]));
    const validated = validateTaskInputResponse(inputRequest, candidate);
    if (!validated.success) {
      setError(validated.error);
      return;
    }
    startTransition(async () => {
      try {
        const response = await fetch(`/api/studies/${studyPublicId}/tasks/${taskPublicId}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: validated.data }),
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
    <section ref={inputRef} className="agent-task-input" aria-label={title}>
      <header><strong>{title}</strong><span>checkpoint 已保留</span></header>
      <p>{description}</p>
      {inputRequest?.fields.map((field) => field.type === "choice" ? (
        <fieldset key={field.key}>
          <legend>{field.label}{field.required ? <span>必填</span> : null}</legend>
          <div className="agent-task-input-options">{field.options?.map((option) => (
            <label key={option} className={values[field.key] === option ? "selected" : ""}>
              <input type="radio" name={field.key} value={option} checked={values[field.key] === option} onChange={() => update(field.key, option)} />
              <span>{option}</span>
            </label>
          ))}</div>
        </fieldset>
      ) : (
        <label key={field.key}>
          <span>{field.label}{field.required ? "（必填）" : ""}</span>
          <textarea
            value={values[field.key] ?? ""}
            maxLength={field.type === "text" ? field.maxLength ?? 600 : undefined}
            onChange={(event) => update(field.key, event.target.value)}
            placeholder={field.type === "url_list" ? "每行一个 https:// URL" : "填写补充信息"}
          />
        </label>
      ))}
      <button type="button" onClick={submit} disabled={pending || !inputRequest}>
        {pending ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
        {pending ? "正在继续" : "提交并继续"}
      </button>
      {error ? <small role="alert">{error}</small> : null}
    </section>
  );
}
