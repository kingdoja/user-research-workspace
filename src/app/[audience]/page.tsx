import { notFound } from "next/navigation";
import { PublicContentPage } from "@/components/public-content-page";

const audiences = {
  marketers: {
    title: "营销研究与消费者洞察",
    description: "在概念、传播和渠道投放之前，通过 AI 人设验证用户反应。",
  },
  "product-managers": {
    title: "用研究洞察驱动产品决策",
    description: "快速验证问题、概念、优先级与产品路线图。",
  },
  "startup-owners": {
    title: "创业团队的高速研究引擎",
    description: "用更短的时间验证市场、用户、定位与增长假设。",
  },
  influencers: {
    title: "为内容与受众之间建立证据",
    description: "理解受众动机、内容偏好与信任建立方式。",
  },
  creators: {
    title: "用用户研究打磨内容方向",
    description: "在创作前识别受众问题，在发布后解释反馈和行为。",
  },
  consultants: {
    title: "咨询项目的 AI 研究工作台",
    description: "快速形成假设、访谈证据、结构化洞察与客户交付。",
  },
} as const;

const items = [
  { title: "发现", description: "将模糊问题转化为明确的研究目标和受众定义。" },
  { title: "测试", description: "让 AI 研究员组织人设访谈、概念测试和反馈收集。" },
  { title: "决策", description: "将访谈证据组织为洞察、建议和可执行的下一步。" },
] as const;

export function generateStaticParams() {
  return Object.keys(audiences).map((audience) => ({ audience }));
}

export default async function AudiencePage({ params }: PageProps<"/[audience]">) {
  const { audience } = await params;
  const content = audiences[audience as keyof typeof audiences];
  if (!content) notFound();
  return <PublicContentPage label="解决方案" {...content} items={items} />;
}
