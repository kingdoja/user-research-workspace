"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { StudyRunReplayOption } from "@/lib/study-run-replay";

export function StudyRunCompareControls({
  studyPublicId,
  options,
  initialLeft,
  initialRight,
}: {
  studyPublicId: string;
  options: StudyRunReplayOption[];
  initialLeft: string;
  initialRight: string;
}) {
  const router = useRouter();
  const [left, setLeft] = useState(initialLeft);
  const [right, setRight] = useState(initialRight);
  const [pending, startTransition] = useTransition();

  function navigate(nextLeft: string, nextRight: string) {
    const query = new URLSearchParams({ left: nextLeft, right: nextRight });
    startTransition(() => router.replace(`/study/${studyPublicId}/compare?${query.toString()}`));
  }

  return (
    <section className="study-compare-controls" aria-label="选择要比较的研究运行">
      <label>
        <span>基准 Run</span>
        <select value={left} onChange={(event) => {
          const value = event.target.value;
          setLeft(value);
          navigate(value, right);
        }}>
          {options.map((option) => (
            <option value={option.publicId} disabled={option.publicId === right} key={option.publicId}>
              第 {option.attempt} 次 · Plan v{option.planVersion} · {option.status}
            </option>
          ))}
        </select>
      </label>
      <span className="study-compare-arrow" aria-hidden="true">→</span>
      <label>
        <span>对照 Run</span>
        <select value={right} onChange={(event) => {
          const value = event.target.value;
          setRight(value);
          navigate(left, value);
        }}>
          {options.map((option) => (
            <option value={option.publicId} disabled={option.publicId === left} key={option.publicId}>
              第 {option.attempt} 次 · Plan v{option.planVersion} · {option.status}
            </option>
          ))}
        </select>
      </label>
      <span className="study-compare-loading" role="status" aria-live="polite">
        {pending ? <><LoaderCircle className="spin" size={14} />正在载入</> : null}
      </span>
    </section>
  );
}
