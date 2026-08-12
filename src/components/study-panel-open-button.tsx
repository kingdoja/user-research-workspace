"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

export function StudyPanelOpenButton({ publicId }: { publicId: string }) {
  return <Link className="agent-panel-open" href={`/panel/${publicId}`}>查看 Panel<ArrowUpRight size={14} /></Link>;
}
