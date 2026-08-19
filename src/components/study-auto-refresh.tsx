"use client";

import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { startTransition, useEffect, useRef, useState } from "react";

type StreamedStudyEvent = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

const visibleEventTypes = new Set([
  "run.started",
  "run.resumed",
  "tool.call.started",
  "tool.call.progress",
  "tool.call.completed",
  "tool.call.failed",
  "agent.turn.started",
  "agent.decision.summary.delta",
  "agent.action.proposed",
  "agent.action.rejected",
  "agent.action.shadow_ignored",
  "agent.replan.accepted",
  "agent.tasks.added",
  "agent.run.waiting_input",
  "agent.turn.completed",
  "agent.controller.failed",
  "reasoning.decision.recorded",
  "research.completed",
  "run.failed",
  "run.cancelled",
]);

function eventLabel(event: StreamedStudyEvent) {
  const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "";
  if (event.type === "tool.call.started") return { title: toolName, detail: "正在调用工具", status: "active" };
  if (event.type === "tool.call.progress") {
    const elapsedMs = typeof event.payload.elapsedMs === "number" ? event.payload.elapsedMs : 0;
    const phase = event.payload.phase === "model" ? "等待模型返回结构化结果" : "工具仍在执行";
    return { title: toolName, detail: `${phase} · ${Math.max(1, Math.round(elapsedMs / 1000))}s`, status: "active" };
  }
  if (event.type === "tool.call.completed") return { title: toolName, detail: "工具调用完成，结果已写入 checkpoint", status: "done" };
  if (event.type === "tool.call.failed") return { title: toolName || "工具调用", detail: typeof event.payload.message === "string" ? event.payload.message : "工具调用失败", status: "failed" };
  if (event.type === "agent.turn.started") return { title: "Agent Controller", detail: "开始读取研究状态并选择下一步", status: "active" };
  if (event.type === "agent.decision.summary.delta") return { title: "下一步决策", detail: typeof event.payload.delta === "string" ? event.payload.delta : "已生成结构化决策摘要", status: "decision" };
  if (event.type === "agent.action.proposed") {
    const action = event.payload.action && typeof event.payload.action === "object" ? event.payload.action as Record<string, unknown> : {};
    return { title: `Agent 动作 · ${typeof action.type === "string" ? action.type : "unknown"}`, detail: typeof event.payload.decisionSummary === "string" ? event.payload.decisionSummary : "已提出动作，等待 Harness 校验", status: "decision" };
  }
  if (event.type === "agent.action.rejected") return { title: "动作被 Harness 拒绝", detail: typeof event.payload.reason === "string" ? event.payload.reason : "动作不满足当前执行约束", status: "failed" };
  if (event.type === "agent.action.shadow_ignored") return { title: "Shadow 决策已记录", detail: "当前灰度模式不改变实际任务 ledger", status: "decision" };
  if (event.type === "agent.replan.accepted") {
    const taskKeys = Array.isArray(event.payload.taskKeys) ? event.payload.taskKeys.filter((key): key is string => typeof key === "string") : [];
    return { title: "动态计划已通过", detail: taskKeys.length ? `已追加 ${taskKeys.join("、")}` : "受控动态任务已加入 ledger", status: "decision" };
  }
  if (event.type === "agent.tasks.added") return { title: "任务 ledger 已更新", detail: "新任务已锁定 Skill 版本并接入报告 gate", status: "active" };
  if (event.type === "agent.run.waiting_input") return { title: "等待补充输入", detail: typeof event.payload.question === "string" ? event.payload.question : "补充信息后将从当前 checkpoint 继续", status: "decision" };
  if (event.type === "agent.turn.completed") return { title: "Agent Controller", detail: event.payload.accepted === true ? "决策已通过校验，进入工具执行" : "决策未执行，继续使用受控调度", status: event.payload.accepted === true ? "active" : "decision" };
  if (event.type === "agent.controller.failed") return { title: "Agent Controller 回退", detail: typeof event.payload.message === "string" ? event.payload.message : "Controller 不可用，已回退到固定任务图", status: "failed" };
  if (event.type === "reasoning.decision.recorded") {
    const action = typeof event.payload.chosenAction === "string" ? event.payload.chosenAction : "continue";
    const reason = typeof event.payload.reason === "string" ? event.payload.reason : "已完成一次调度检查";
    return { title: `调度决策 · ${action}`, detail: reason, status: "decision" };
  }
  if (event.type === "run.failed") return { title: "研究运行失败", detail: typeof event.payload.message === "string" ? event.payload.message : "运行已停止", status: "failed" };
  if (event.type === "run.cancelled") return { title: "研究运行已取消", detail: "执行已停止", status: "failed" };
  if (event.type === "research.completed") return { title: "研究运行完成", detail: "所有必需任务已完成", status: "done" };
  return { title: event.type === "run.resumed" ? "继续研究运行" : "启动研究运行", detail: "Worker 已接管任务图并开始执行", status: "active" };
}

function mergeEvent(events: StreamedStudyEvent[], incoming: StreamedStudyEvent) {
  if (events.some((event) => event.id === incoming.id)) return events;
  const next = incoming.type === "tool.call.progress"
    ? events.filter((event) => event.type !== "tool.call.progress" || event.payload.invocationId !== incoming.payload.invocationId)
    : events;
  return [...next, incoming].slice(-10);
}

export function StudyAutoRefresh({
  publicId,
  after,
  initialEvents,
}: {
  publicId: string;
  after: string;
  initialEvents: StreamedStudyEvent[];
}) {
  const router = useRouter();
  const cursor = useRef(after);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState(() => initialEvents.filter((event) => visibleEventTypes.has(event.type)).slice(-10));

  useEffect(() => {
    cursor.current = after;
    const stream = new EventSource(`/api/studies/${publicId}/events?after=${encodeURIComponent(cursor.current)}`);
    const refresh = (event: MessageEvent<string>) => {
      if (event.lastEventId) cursor.current = event.lastEventId;
      try {
        const parsed = JSON.parse(event.data) as StreamedStudyEvent;
        if (visibleEventTypes.has(parsed.type)) setEvents((current) => mergeEvent(current, parsed));
      } catch {}
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => startTransition(() => router.refresh()), 180);
    };
    const opened = () => setConnected(true);
    const closed = () => setConnected(false);
    stream.addEventListener("open", opened);
    stream.addEventListener("error", closed);
    stream.addEventListener("study-event", refresh as EventListener);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      stream.removeEventListener("open", opened);
      stream.removeEventListener("error", closed);
      stream.removeEventListener("study-event", refresh as EventListener);
      stream.close();
    };
  }, [after, publicId, router]);

  const latest = events.at(-1);
  return (
    <section className="agent-event-stream" aria-label="实时执行事件">
      <header>
        <span><LoaderCircle className={connected ? "spin" : ""} size={13} />实时过程</span>
        <small>{connected ? "SSE 已连接" : "正在重连"}</small>
      </header>
      {latest ? <p aria-live="polite">{eventLabel(latest).detail}</p> : null}
      <ol>
        {events.map((event) => {
          const presentation = eventLabel(event);
          const argumentsValue = event.type === "tool.call.started" ? event.payload.arguments : null;
          return (
            <li className={`event-${presentation.status}`} key={event.id}>
              <span />
              <div>
                <header><strong>{presentation.title}</strong><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></header>
                <p>{presentation.detail}</p>
                {argumentsValue && typeof argumentsValue === "object" ? <details><summary>调用参数</summary><pre>{JSON.stringify(argumentsValue, null, 2)}</pre></details> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
