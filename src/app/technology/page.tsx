import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

const technologyBlocks = [
  ["主观世界模型", "将访谈、语义、经历和决策模式组织成可交互的认知模型。"],
  ["AI SIMULATOR", "生成保持一致个性、记忆和行为逻辑的 AI Personas。"],
  ["AI RESEARCHER", "编排访谈、研究和分析工作流，将问题转化为可交付洞察。"],
];

export default function TechnologyPage() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main>
        <section className="technology-hero">
          <div className="site-container technology-hero-inner">
            <p className="tech-version">ATYPICA 2.0</p>
            <h1>理解人的<br /><em>AI</em></h1>
            <p>大多数 AI 替人干活。我们相信 AI 还有第二种形态——理解人的主观世界。</p>
            <div className="technology-actions">
              <Link className="button button-green" href="/newstudy">开始研究 <ArrowRight size={17} /></Link>
              <a className="text-link" href="#model">了解更多</a>
            </div>
            <div className="tech-stats"><span>100万+ AI 人设</span><span>85% 仿真准确率</span><span>全球企业信赖</span></div>
          </div>
        </section>
        <section className="technology-model site-container" id="model">
          <p className="section-label">理解人的 AI</p>
          <h2>从客观世界，走向主观世界</h2>
          <blockquote>“我们并不是对现实做反应，而是对我们头脑中的模型做反应。”</blockquote>
          <div className="tech-block-grid">
            {technologyBlocks.map(([title, description], index) => (
              <article key={title}>
                <span>0{index + 1}</span><h3>{title}</h3><p>{description}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="technology-cta section-band">
          <div className="site-container">
            <h2>准备好理解你的用户了吗？</h2>
            <Link className="button button-green" href="/newstudy">开始研究 <ArrowRight size={18} /></Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
