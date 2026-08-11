import { notFound } from "next/navigation";
import { PublicContentPage } from "@/components/public-content-page";

const solutions = {
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
} as const;

const items = [
  { title: "发现", description: "将模糊问题转化为明确的研究目标和受众定义。" },
  { title: "测试", description: "让 AI 研究员组织人设访谈、概念测试和反馈收集。" },
  { title: "决策", description: "将访谈证据组织为洞察、建议和可执行的下一步。" },
] as const;

export function generateStaticParams() {
  return Object.keys(solutions).map((slug) => ({ slug }));
}

export default async function SolutionPage({ params }: PageProps<"/solutions/[slug]">) {
  const { slug } = await params;
  const solution = solutions[slug as keyof typeof solutions];
  if (!solution) notFound();
  return <PublicContentPage label="解决方案" {...solution} items={items} />;
}
