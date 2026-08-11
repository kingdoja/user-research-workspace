import { ArrowRight, FileUp } from "lucide-react";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

type ProductPageProps = {
  kicker: string;
  title: string;
  description: string;
  primary: string;
  secondary?: string;
  headings: readonly string[];
};

export function ProductPage({
  kicker,
  title,
  description,
  primary,
  secondary,
  headings,
}: ProductPageProps) {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main>
        <section className="product-hero site-container">
          <p className="product-kicker">{kicker}</p>
          <h1>{title}</h1>
          <p className="product-lede">{description}</p>
          <div className="product-actions">
            <Link className="button button-dark-wide" href="/auth/signin">
              {primary.includes("PDF") ? <FileUp size={17} /> : null}
              {primary}
              <ArrowRight size={17} />
            </Link>
            {secondary ? (
              <Link className="button button-outline-wide" href="/auth/signin">
                {secondary}
                <ArrowRight size={17} />
              </Link>
            ) : null}
          </div>
        </section>
        <section className="product-process section-band">
          <div className="site-container">
            <p className="section-label">工作原理</p>
            <div className="process-list">
              {headings.map((heading, index) => (
                <article key={heading}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <h2>{heading}</h2>
                  <p>在一个连续的研究工作流中保留资料、上下文和分析结果。</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
