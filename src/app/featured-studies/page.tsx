import { PublicContentPage } from "@/components/public-content-page";

const items = [
  { title: "消费者生活方式研究", description: "识别不同年龄阶段的价值观、行为模式和品牌选择。" },
  { title: "职业转型路径规划", description: "结合个人约束、能力和市场需求构建可执行方案。" },
  { title: "AI 内容市场入局策略", description: "从需求、供给、用户偏好和变现方式评估机会。" },
] as const;

export default function FeaturedStudiesPage() {
  return <PublicContentPage label="精选案例" title="AI 人设研究案例" description="从实际研究问题、访谈证据和结构化报告中查看 AI 研究工作流。" items={items} />;
}
