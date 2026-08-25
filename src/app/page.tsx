import { ArrowRight, CheckCircle2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { VideoPanel } from "@/components/video-panel";
import { avatars, showcaseItems } from "@/lib/site-data";

const workflow = [
  ["AI人设生成", "基于真实行为模式和人口统计洞察，生成多样化的 AI 人设。"],
  ["AI主导访谈", "进行自然对话，挖掘深层动机和关键决策因素。"],
  ["行为分析", "识别影响购买决策的情感触发点、认知偏差和文化因素。"],
  ["即时洞察", "在数分钟内生成可以交付和分享的全面研究报告。"],
];

const cases = [
  "奢侈品入口级女性消费者的生活方式与消费理念变化研究",
  "35岁技术背景宝妈离职后的职业路径规划",
  "AI 短剧市场潜力与入局策略研究梳理与评估",
];

export default function Home() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main>
        <section className="home-hero site-container">
          <div className="pixel pixel-one" />
          <div className="pixel pixel-two" />
          <h1>商业研究多智能体</h1>
          <p className="hero-lede">Cognara 模拟消费者决策，全自动访谈和分析，并产出报告。</p>
          <div className="hero-actions">
            <div>
              <Link className="button button-green" href="/newstudy">
                开始您的研究 <ArrowRight size={18} />
              </Link>
              <p>无需信用卡 · 赠送 1,000,000 免费 Token</p>
            </div>
            <div className="trust-row">
              <div className="avatar-stack">
                {avatars.map((avatar) => (
                  <Image key={avatar.src} src={avatar.src} alt={avatar.alt} width={38} height={38} />
                ))}
              </div>
              <div>
                <div className="stars" aria-label="5 星评价">★★★★★</div>
                <p>受到各大机构用户信赖 · <CheckCircle2 size={13} /> SOC2 合规</p>
              </div>
            </div>
          </div>
        </section>

        <section className="site-container promo-section">
          <VideoPanel
            featured
            title="Cognara AI"
            poster="/assets/hero-poster.jpeg"
            video="https://bmrlab-s3.musecdn1.com/atypica/public/atypica-promo-20250627.mp4?region=us-east-1"
          />
        </section>

        <section className="metrics-section site-container">
          <h2>大规模AI用户画像研究</h2>
          <p className="metrics-lede">构建真人智能体以理解 <em>人类决策</em></p>
          <div className="topic-tags"><span>AI人设</span><span>专家访谈</span><span>行为洞察</span></div>
          <div className="metric-grid">
            <div><strong>300K</strong><span>AI人设创建</span></div>
            <div><strong>+1M</strong><span>访谈已完成</span></div>
            <div><strong>&lt;30m</strong><span>每次研究用时</span></div>
          </div>
        </section>

        <section className="practice-section section-band">
          <div className="site-container">
            <p className="section-label">研究应用</p>
            <h2>AI人设研究实践</h2>
            <p className="section-intro">
              了解高精度 AI 人设如何在不同场景中转换研究方式，从概念测试到洞察发现。
            </p>
            <div className="showcase-grid">
              {showcaseItems.map((item) => <VideoPanel key={item.title} {...item} />)}
            </div>
          </div>
        </section>

        <section className="workflow-section site-container">
          <p className="section-label">主观世界建模实践</p>
          <h2>从问题到洞察，数分钟内完成</h2>
          <div className="workflow-grid">
            {workflow.map(([title, description], index) => (
              <article key={title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="case-section section-band">
          <div className="site-container">
            <p className="section-label">我们的工作</p>
            <h2>AI人设研究案例</h2>
            <div className="case-list">
              {cases.map((item, index) => (
                <article key={item}>
                  <span>0{index + 1}</span>
                  <h3>{item}</h3>
                  <Link href="/featured-studies" aria-label={`查看案例：${item}`}><ArrowRight /></Link>
                </article>
              ))}
            </div>
            <Link className="text-link" href="/featured-studies">查看所有研究 <ArrowRight size={17} /></Link>
          </div>
        </section>

        <section className="technology-summary site-container">
          <div>
            <p className="section-label">核心技术</p>
            <h2>通过深度访谈构建 AI 人设</h2>
          </div>
          <div>
            <p>模拟真实人类认知的高级 AI 人设，保持一致的个性、情感反应和决策框架。</p>
            <div className="accuracy"><strong>85%</strong><span>模拟准确度</span></div>
            <Link className="button button-green" href="/technology">了解技术 <ArrowRight size={18} /></Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
