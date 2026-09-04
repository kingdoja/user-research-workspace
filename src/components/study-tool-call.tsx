"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useRef } from "react";

export function StudyToolCall({
  name,
  status = "done",
  children,
  autoFocus = false,
  scrollTargetSelector,
}: {
  name: string;
  status?: "done" | "active" | "waiting" | "failed";
  children?: React.ReactNode;
  autoFocus?: boolean;
  scrollTargetSelector?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if ((!autoFocus && status !== "active") || !ref.current) return;
    ref.current.open = true;
    const timer = window.setTimeout(() => {
      const target = scrollTargetSelector
        ? ref.current?.querySelector<HTMLElement>(scrollTargetSelector)
        : ref.current;
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [autoFocus, scrollTargetSelector, status]);

  return (
    <details ref={ref} className={`agent-tool-call tool-${status}`} open={autoFocus || status === "active" || status === "failed"}>
      <summary><ChevronRight size={15} /><span>exec</span><strong>{name}</strong>{children ? <small>查看过程</small> : null}</summary>
      {children ? <div className="agent-tool-body">{children}</div> : null}
    </details>
  );
}
