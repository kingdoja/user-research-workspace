import type { InterviewProjectDetail, InterviewSessionDetail } from "@/lib/interviews";

export type InterviewSourceFilter = "all" | "ai" | "human";

export type InterviewTheme = {
  id: string;
  label: string;
  insight: string;
  sessionPublicId: string;
  participantNames: string[];
  sourceTypes: Array<"ai" | "human">;
  evidence: Array<{
    sessionPublicId: string;
    participantName: string;
    sessionType: "ai" | "human";
    text: string;
  }>;
};

export type InterviewDifference = {
  questionPublicId: string;
  question: string;
  answers: Array<{
    sessionPublicId: string;
    participantName: string;
    sessionType: "ai" | "human";
    excerpt: string;
  }>;
};

export type InterviewHypothesis = {
  id: string;
  statement: string;
  validation: string;
  sessionPublicId: string;
};

const themeRules = [
  { id: "decision", label: "决策标准", keywords: ["决策", "选择", "比较", "判断", "标准", "购买", "优先"] },
  { id: "needs", label: "需求与目标", keywords: ["需求", "目标", "希望", "想要", "期待", "需要", "动机"] },
  { id: "barriers", label: "阻碍与痛点", keywords: ["痛点", "担心", "顾虑", "困难", "问题", "风险", "不便", "焦虑"] },
  { id: "usage", label: "使用场景", keywords: ["场景", "使用", "通勤", "日常", "频率", "环境", "流程"] },
  { id: "value", label: "价格与价值", keywords: ["价格", "预算", "成本", "费用", "价值", "性价比", "付费"] },
  { id: "product", label: "产品体验", keywords: ["功能", "体验", "续航", "性能", "操作", "设计", "质量"] },
  { id: "trust", label: "信任与信息", keywords: ["信任", "可信", "评价", "信息", "宣传", "口碑", "证据"] },
  { id: "service", label: "服务与保障", keywords: ["售后", "服务", "保障", "维修", "保修", "支持", "响应"] },
] as const;

function excerpt(value: string, limit = 110) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function resolveTheme(text: string) {
  let best: (typeof themeRules)[number] | null = null;
  let bestScore = 0;
  for (const rule of themeRules) {
    const score = rule.keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) { best = rule; bestScore = score; }
  }
  return best ?? { id: "other", label: "其他观察", keywords: [] };
}

function filteredSessions(sessions: InterviewSessionDetail[], source: InterviewSourceFilter) {
  return source === "all" ? sessions : sessions.filter((session) => session.sessionType === source);
}

export function buildInterviewThemes(project: InterviewProjectDetail, source: InterviewSourceFilter = "all") {
  const grouped = new Map<string, InterviewTheme>();
  for (const session of filteredSessions(project.sessions, source)) {
    for (const insight of session.insights) {
      const rule = resolveTheme(insight);
      const current = grouped.get(rule.id) ?? {
        id: rule.id,
        label: rule.label,
        insight: "",
        sessionPublicId: session.publicId,
        participantNames: [],
        sourceTypes: [],
        evidence: [],
      };
      if (!current.participantNames.includes(session.participantName)) current.participantNames.push(session.participantName);
      if (!current.sourceTypes.includes(session.sessionType)) current.sourceTypes.push(session.sessionType);
      current.evidence.push({
        sessionPublicId: session.publicId,
        participantName: session.participantName,
        sessionType: session.sessionType,
        text: insight,
      });
      grouped.set(rule.id, current);
    }
  }
  return [...grouped.values()]
    .map((theme) => ({
      ...theme,
      insight: `“${theme.label}”在 ${theme.participantNames.length} 位参与者的访谈记录中出现，建议作为后续验证重点。`,
    }))
    .sort((left, right) => right.participantNames.length - left.participantNames.length || right.evidence.length - left.evidence.length);
}

export function buildInterviewDifferences(project: InterviewProjectDetail, source: InterviewSourceFilter = "all") {
  return project.questions.flatMap<InterviewDifference>((question) => {
    const answers = question.answers
      .filter((answer) => source === "all" || answer.sessionType === source)
      .map((answer) => ({
        sessionPublicId: answer.sessionPublicId,
        participantName: answer.personaName,
        sessionType: answer.sessionType,
        excerpt: excerpt(answer.answer),
      }));
    if (answers.length < 2) return [];
    return [{ questionPublicId: question.publicId, question: question.question, answers: answers.slice(0, 4) }];
  });
}

export function buildInterviewHypotheses(themes: InterviewTheme[]) {
  return themes.slice(0, 4).map<InterviewHypothesis>((theme) => ({
    id: theme.id,
    statement: `${theme.label}可能是影响目标用户行为或决策的重要因素。`,
    validation: `在真人样本中验证出现条件、影响强度与不同用户类型之间的差异；当前依据来自 ${theme.participantNames.length} 位参与者的访谈记录。`,
    sessionPublicId: theme.sessionPublicId,
  }));
}

export function getInterviewSourceCounts(project: InterviewProjectDetail) {
  return {
    all: project.sessions.length,
    ai: project.sessions.filter((session) => session.sessionType === "ai").length,
    human: project.sessions.filter((session) => session.sessionType === "human").length,
  };
}

export function getQuestionCoverage(project: InterviewProjectDetail, source: InterviewSourceFilter) {
  const sessionCount = filteredSessions(project.sessions, source).length;
  return project.questions.map((question) => {
    const answerCount = question.answers.filter((answer) => source === "all" || answer.sessionType === source).length;
    return { questionPublicId: question.publicId, answerCount, sessionCount };
  });
}
