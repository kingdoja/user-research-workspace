"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function StudyReplayControls({ runId, stepCount }: { runId: string; stepCount: number }) {
  const [position, setPosition] = useState(stepCount);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const timeline = document.querySelector<HTMLElement>(`[data-replay-run="${CSS.escape(runId)}"]`);
    if (!timeline) return;
    const steps = Array.from(timeline.querySelectorAll<HTMLElement>(".agent-task-event"));
    steps.forEach((step, index) => {
      step.hidden = index >= position;
    });
    const current = steps[Math.max(0, position - 1)];
    if (playing && current) current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [playing, position, runId]);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setPosition((current) => {
        if (current >= stepCount) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1100);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, stepCount]);

  function restart() {
    setPlaying(false);
    setPosition(0);
  }

  function toggle() {
    if (position >= stepCount) setPosition(0);
    setPlaying((current) => !current);
  }

  return (
    <section className="agent-replay-controls" aria-label="研究过程回放">
      <button type="button" onClick={restart} title="从头回放" aria-label="从头回放"><RotateCcw size={14} /></button>
      <button type="button" onClick={toggle} title={playing ? "暂停回放" : "播放回放"} aria-label={playing ? "暂停回放" : "播放回放"}>
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <input
        type="range"
        min="0"
        max={stepCount}
        value={position}
        onChange={(event) => { setPlaying(false); setPosition(Number(event.target.value)); }}
        aria-label="回放进度"
      />
      <strong>{position}/{stepCount}</strong>
    </section>
  );
}
