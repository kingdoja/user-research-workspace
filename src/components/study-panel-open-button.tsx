"use client";

import { ArrowUpRight } from "lucide-react";

export function StudyPanelOpenButton() {
  return <button type="button" className="agent-panel-open" onClick={() => window.dispatchEvent(new Event("atypica:panel"))}>查看 Panel<ArrowUpRight size={14} /></button>;
}
