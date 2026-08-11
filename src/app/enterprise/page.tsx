import { PublicContentPage } from "@/components/public-content-page";

const items = [
  { title: "安全与合规", description: "以组织、团队和项目维度管理访问权限与研究资产。" },
  { title: "团队协作", description: "共享 AI 人设、专家、研究和报告，保留完整的过程记录。" },
  { title: "API 与集成", description: "将研究能力接入内部数据、工作流和交付系统。" },
] as const;

export default function EnterprisePage() {
  return <PublicContentPage label="ENTERPRISE" title="企业级研究基础设施" description="为研究、产品和营销团队提供安全、可管理的 AI 研究工作流。" items={items} />;
}
