import type { StudyMethod } from "@/lib/research-types";

export const studyTypeLabels: Record<string, string> = {
  user_research: "用户研究",
  fast_insight: "快速洞察",
  product_rnd: "产品研发",
  panel_only: "Panel 构建",
};

export const studyStatusLabels: Record<string, string> = {
  planning: "规划中",
  awaiting_confirmation: "待确认",
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

export const methodLabels: Record<StudyMethod, string> = {
  "Interview Chat": "AI 深访",
  "Discussion Chat": "AI 讨论",
  "Scout Agent": "趋势扫描",
  "Fast Insight": "快速洞察",
};

export function formatTokens(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatStudyDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function formatDuration(minutes: number) {
  if (minutes >= 1440) {
    const days = Math.ceil(minutes / 1440);
    return `${days} 天内`;
  }

  if (minutes >= 60) {
    return `${Math.ceil(minutes / 60)} 小时内`;
  }

  return `${minutes} 分钟内`;
}
