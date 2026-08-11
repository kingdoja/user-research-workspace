export const navigation = [
  { label: "技术", href: "/technology" },
  { label: "产品", href: "/persona" },
  { label: "解决方案", href: "/marketers" },
  { label: "价格", href: "/pricing" },
];

export const avatars = [
  { src: "/assets/avatar-sarah.webp", alt: "Sarah Chen" },
  { src: "/assets/avatar-marcus.webp", alt: "Marcus Johnson" },
  { src: "/assets/avatar-emily.webp", alt: "Emily Rodriguez" },
  { src: "/assets/avatar-david.webp", alt: "David Kim" },
  { src: "/assets/avatar-jessica.webp", alt: "Jessica Taylor" },
];

export const showcaseItems = [
  {
    title: "测试",
    description: "访谈 AI 人设以测试产品概念和活动创意，获得真实反馈。",
    poster: "/assets/testing.webp",
    video:
      "https://bmrlab-s3.musecdn1.com/atypica/public/atypica-showcase-testing-20250627.mp4?region=us-east-1",
  },
  {
    title: "规划",
    description: "了解偏好和优先级，创建可以指导路线图制定的研究框架。",
    poster: "/assets/planning.webp",
    video:
      "https://bmrlab-s3.musecdn1.com/atypica/public/atypica-showcase-planning-20250627.mp4?region=us-east-1",
  },
  {
    title: "洞察",
    description: "访谈代表目标受众的 AI 人设，揭示行为模式和深层动机。",
    poster: "/assets/insights.webp",
    video:
      "https://bmrlab-s3.musecdn1.com/atypica/public/atypica-showcase-insights-20250627.mp4?region=us-east-1",
  },
  {
    title: "创意",
    description: "与 AI 人设头脑风暴和共创，产生新想法并验证创意概念。",
    poster: "/assets/creation.webp",
    video:
      "https://bmrlab-s3.musecdn1.com/atypica/public/atypica-showcase-creation-20250627.mp4?region=us-east-1",
  },
];

export const productPages = {
  persona: {
    kicker: "PERSONA PLATFORM",
    title: "构建 AI 人设",
    description:
      "导入访谈记录，分析完整性，并生成互动式 AI 人设，满足您的研究和分析需求。",
    primary: "上传PDF文件",
    secondary: "查看我的 AI 人设",
    headings: ["导入访谈", "追加访谈", "与 AI 人设对话", "使用 AI 人设进行研究"],
  },
  interview: {
    kicker: "INTERVIEW PLATFORM",
    title: "AI 智能访谈研究",
    description:
      "与真实用户和 AI 人设进行专业访谈。通过智能访谈员自动生成洞察。",
    primary: "开始使用",
    headings: ["真人访谈", "AI 人设访谈", "智能分析", "生成报告"],
  },
  sage: {
    kicker: "专家智能体平台",
    title: "构建AI专家智能体",
    description:
      "导入专业知识文档，AI 自动分析完整性并生成专家记忆文档，打造您的专属领域专家。",
    primary: "开始创建",
    secondary: "查看我的专家",
    headings: ["知识导入", "知识分析", "补充访谈", "专家咨询"],
  },
} as const;
