import type { PublicWebSource } from "@/lib/public-web-search";

export type ResearchQuestionType = "factual" | "behavioral" | "attitudinal" | "comparative" | "causal" | "strategic";
export type ResearchAnswerabilityLevel = "decision_ready" | "directional" | "insufficient";

export type SourceQualityAssessment = {
  accepted: boolean;
  score: number;
  reasons: string[];
  signals: string[];
};

export type CuratedPublicWebSources = {
  sources: PublicWebSource[];
  rejected: Array<{ source: PublicWebSource; assessment: SourceQualityAssessment }>;
  assessments: Array<{ source: PublicWebSource; assessment: SourceQualityAssessment }>;
};

export type ResearchAnswerability = {
  level: ResearchAnswerabilityLevel;
  questionTypes: ResearchQuestionType[];
  reportLabel: string;
  basisLabel: string;
  usableSourceCount: number;
  platformSourceCount: number;
  behavioralEvidenceCount: number;
  attitudinalEvidenceCount: number;
  brandCoverage: string[];
  gaps: string[];
  requiredEvidence: string[];
};

const QUESTION_PATTERNS: Array<[ResearchQuestionType, RegExp]> = [
  ["behavioral", /分享|收藏|转发|点击|购买|转化|使用|留存|复购|到店|预约|互动|行为/u],
  ["attitudinal", /信任|偏好|动机|原因|顾虑|态度|看法|满意|认知|痛点|需求/u],
  ["comparative", /比较|对比|差异|竞品|品牌|细分|分别|相比|与.+(?:和|及|vs|VS)/u],
  ["causal", /是否会|能否提高|能否降低|影响|导致|驱动|因果|效果|提升/u],
  ["strategic", /建议|方案|策略|机会|方向|优先|应该|如何做|内容/u],
  ["factual", /规模|参数|价格|销量|政策|法规|市场|份额|趋势|现状/u],
];

const PLATFORM_HOSTS = [
  "xiaohongshu.com",
  "douyin.com",
  "bilibili.com",
  "weibo.com",
  "zhihu.com",
  "kuaishou.com",
];

const BEHAVIOR_SIGNAL_PATTERN = /收藏(?:量|数|率)?|分享(?:量|数|率)?|转发(?:量|数|率)?|评论(?:量|数|率)?|点赞(?:量|数|率)?|播放(?:量|数)?|互动率|完播率|点击率|转化率/u;
const ATTITUDE_SIGNAL_PATTERN = /用户(?:表示|认为|提到|反馈|评价|抱怨)|评论区|真实体验|亲身经历|我(?:认为|觉得|担心|喜欢|不喜欢|购买|使用)/u;
const UNAVAILABLE_PATTERN = /temporarily unavailable|undergoing(?: planned)? maintenance|access denied|页面不存在|网页不存在|暂时无法访问|系统维护|访问受限|404 not found/i;
const PROMOTIONAL_PATTERN = /销量第一|全球第一|领跑|刷屏全网|一骑绝尘|技术底气|闭眼入|天花板|千万用户选择|现象级|核心密码/u;
const CATEGORY_PATTERN = /两轮电动车|电动自行车|电摩|电动摩托车|e-?bike|electric two-wheeler/i;
const FOREIGN_SCOOTER_PATTERN = /electric scooter|kick scooter|segway ninebot max|ninebot es\d/i;

const ENTITY_ALIASES: Array<{ name: string; detect: RegExp; aliases: RegExp }> = [
  { name: "九号", detect: /九号|Ninebot|Segway/u, aliases: /九号|Ninebot|Segway/u },
  { name: "雅迪", detect: /雅迪|Yadea/u, aliases: /雅迪|Yadea/u },
  { name: "小牛", detect: /小牛|NIU/u, aliases: /小牛|NIU/u },
  { name: "爱玛", detect: /爱玛|AIMA/u, aliases: /爱玛|AIMA/u },
];

const RESEARCH_DIMENSIONS = [
  "续航", "价格", "功能", "智能", "安全", "售后", "通勤", "场景", "内容", "信任", "收藏", "分享", "比较", "评测", "体验",
];

const GENERIC_RELEVANCE_TERMS = new Set([
  "研究", "报告", "分析", "资料", "公开", "网页", "信息", "用户", "市场", "产品", "功能", "体验", "需求", "目标",
  "内容", "场景", "问题", "了解", "希望", "需要", "可以", "是否", "如何", "哪些", "什么", "以及", "关于", "通过",
  "建议", "方案", "方法", "行业", "公司", "企业", "客户", "服务", "使用", "相关", "主要", "不同", "当前", "中国",
]);

function extractRelevanceTerms(value: string) {
  const latinTerms = value.toLowerCase().match(/[a-z][a-z0-9-]{2,24}/g) ?? [];
  const hanRuns = value.match(/[\u4e00-\u9fff]+/gu) ?? [];
  const hanTerms = hanRuns.flatMap((run) => {
    if (run.length <= 8) return [run];
    const grams: string[] = [];
    for (let index = 0; index < run.length - 1; index += 1) grams.push(run.slice(index, index + 2));
    return grams;
  });
  return [...new Set([...latinTerms, ...hanTerms])]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !GENERIC_RELEVANCE_TERMS.has(term));
}

function sourceHost(source: PublicWebSource) {
  try {
    return new URL(source.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function requestedEntities(brief: string) {
  return ENTITY_ALIASES.filter((entity) => entity.detect.test(brief));
}

export function classifyResearchQuestionTypes(brief: string): ResearchQuestionType[] {
  const types = QUESTION_PATTERNS.flatMap(([type, pattern]) => pattern.test(brief) ? [type] : []);
  if (requestedEntities(brief).length > 1) types.push("comparative");
  const orderedTypes = ["behavioral", "attitudinal", "comparative", "causal", "strategic", "factual"] as ResearchQuestionType[];
  const uniqueTypes = [...new Set(types)];
  return uniqueTypes.length ? orderedTypes.filter((type) => uniqueTypes.includes(type)) : ["factual"];
}

export function isPlatformSource(source: PublicWebSource) {
  const host = sourceHost(source);
  return PLATFORM_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function assessPublicWebSourceQuality(source: PublicWebSource, brief: string, searchTerms: string[] = []): SourceQualityAssessment {
  const text = `${source.title}\n${source.excerpt}`;
  const reasons: string[] = [];
  const signals: string[] = [];
  const templateTokenCount = text.match(/\{\{[^}]+\}\}/g)?.length ?? 0;

  if (UNAVAILABLE_PATTERN.test(text)) reasons.push("unavailable_page");
  if (templateTokenCount >= 2 || /模板|template|placeholder|lorem ipsum/i.test(text)) reasons.push("template_shell");
  if (source.excerpt.trim().length < 160) reasons.push("insufficient_content");
  if (!sourceHost(source)) reasons.push("invalid_url");
  if (reasons.length) return { accepted: false, score: -10, reasons, signals };

  let score = 0;
  const relevanceTerms = extractRelevanceTerms([brief, ...searchTerms].join("\n"));
  const matchedRelevanceTerms = relevanceTerms.filter((term) => text.toLowerCase().includes(term.toLowerCase()));
  if (matchedRelevanceTerms.length) {
    score += Math.min(4, matchedRelevanceTerms.length);
    signals.push(`brief_term_match:${matchedRelevanceTerms.slice(0, 4).join(",")}`);
  }
  const entities = requestedEntities(brief);
  for (const entity of entities) {
    if (entity.aliases.test(text)) {
      score += 3;
      signals.push(`entity:${entity.name}`);
    }
  }
  if (CATEGORY_PATTERN.test(text)) {
    score += 2;
    signals.push("category_match");
  }
  const matchedDimensions = RESEARCH_DIMENSIONS.filter((dimension) => brief.includes(dimension) && text.includes(dimension));
  if (matchedDimensions.length) {
    score += Math.min(3, matchedDimensions.length);
    signals.push(...matchedDimensions.map((dimension) => `dimension:${dimension}`));
  }
  if (isPlatformSource(source)) {
    score += 2;
    signals.push("platform_source");
  }
  if (BEHAVIOR_SIGNAL_PATTERN.test(text)) {
    score += 2;
    signals.push("behavior_signal");
  }
  if (ATTITUDE_SIGNAL_PATTERN.test(text)) {
    score += 1;
    signals.push("attitude_signal");
  }
  if (PROMOTIONAL_PATTERN.test(text)) {
    score -= 2;
    signals.push("promotional_risk");
  }
  if (/两轮电动车|电动自行车|电摩/u.test(brief) && FOREIGN_SCOOTER_PATTERN.test(text) && !CATEGORY_PATTERN.test(text)) {
    score -= 3;
    signals.push("category_mismatch_risk");
  }

  const accepted = score >= 1;
  if (!accepted) reasons.push("low_relevance");
  return { accepted, score, reasons, signals };
}

export function curatePublicWebSources(brief: string, sources: PublicWebSource[], limit = 24, searchTerms: string[] = []): CuratedPublicWebSources {
  const assessments = sources.map((source) => ({ source, assessment: assessPublicWebSourceQuality(source, brief, searchTerms) }));
  const accepted = assessments
    .filter((item) => item.assessment.accepted)
    .toSorted((left, right) => right.assessment.score - left.assessment.score)
    .slice(0, limit);
  return {
    sources: accepted.map((item) => item.source),
    rejected: assessments.filter((item) => !item.assessment.accepted),
    assessments,
  };
}

export function assessResearchAnswerability(input: {
  brief: string;
  sources: PublicWebSource[];
  hasHumanObservations?: boolean;
  hasSyntheticResearch?: boolean;
}): ResearchAnswerability {
  const questionTypes = classifyResearchQuestionTypes(input.brief);
  const platformSources = input.sources.filter(isPlatformSource);
  const behavioralSources = platformSources.filter((source) => BEHAVIOR_SIGNAL_PATTERN.test(`${source.title}\n${source.excerpt}`));
  const attitudinalSources = input.sources.filter((source) => ATTITUDE_SIGNAL_PATTERN.test(`${source.title}\n${source.excerpt}`));
  const brandCoverage = requestedEntities(input.brief)
    .filter((entity) => input.sources.some((source) => entity.aliases.test(`${source.title}\n${source.excerpt}`)))
    .map((entity) => entity.name);
  const gaps: string[] = [];
  const requiredEvidence: string[] = [];

  if (questionTypes.includes("behavioral") && behavioralSources.length < 3) {
    gaps.push("缺少能够直接反映分享、收藏、点击或转化行为的平台级证据。被索引的网页内容不能替代行为数据。");
    requiredEvidence.push("帖子级互动数据、产品行为日志或经过同意的行为观察");
  }
  if (questionTypes.includes("attitudinal") && !input.hasHumanObservations && attitudinalSources.length < 3) {
    gaps.push("缺少足够的第一人称用户表达，无法把信任、偏好或动机作为已验证态度结论。");
    requiredEvidence.push("真人访谈、问卷、评论语料或其他第一人称用户材料");
  }
  if (questionTypes.includes("causal")) {
    gaps.push("当前证据不能识别因果关系，只能形成待实验验证的方向。");
    requiredEvidence.push("A/B 测试、实验或具备对照条件的准实验数据");
  }
  const expectedBrandCount = requestedEntities(input.brief).length;
  if (questionTypes.includes("comparative") && expectedBrandCount > 1 && brandCoverage.length < expectedBrandCount) {
    gaps.push("比较对象的证据覆盖不平衡，不能形成对称的品牌或方案比较结论。");
    requiredEvidence.push("针对每个比较对象采用同一采样范围和分析维度的平衡证据");
  }

  const level: ResearchAnswerabilityLevel = input.sources.length < 3
    ? "insufficient"
    : gaps.length
      ? "directional"
      : "decision_ready";

  return {
    level,
    questionTypes,
    reportLabel: level === "decision_ready"
      ? "决策研究报告"
      : level === "directional"
        ? "公开资料方向性分析与行动方案"
        : "证据缺口与研究方案",
    basisLabel: level === "decision_ready"
      ? "现有证据可支持主要结论"
      : level === "directional"
        ? "现有证据支持方向性判断，不代表已验证的受众规律"
        : "现有证据不足以回答核心问题",
    usableSourceCount: input.sources.length,
    platformSourceCount: platformSources.length,
    behavioralEvidenceCount: behavioralSources.length,
    attitudinalEvidenceCount: attitudinalSources.length + (input.hasHumanObservations ? 1 : 0),
    brandCoverage,
    gaps,
    requiredEvidence: [...new Set(requiredEvidence)],
  };
}

export function formatResearchAnswerabilityForPrompt(assessment: ResearchAnswerability) {
  return JSON.stringify({
    level: assessment.level,
    questionTypes: assessment.questionTypes,
    requiredReportLabel: assessment.reportLabel,
    basis: assessment.basisLabel,
    usableSourceCount: assessment.usableSourceCount,
    platformSourceCount: assessment.platformSourceCount,
    behavioralEvidenceCount: assessment.behavioralEvidenceCount,
    attitudinalEvidenceCount: assessment.attitudinalEvidenceCount,
    brandCoverage: assessment.brandCoverage,
    gaps: assessment.gaps,
    requiredEvidence: assessment.requiredEvidence,
  }, null, 2);
}
