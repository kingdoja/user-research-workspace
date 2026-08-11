import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

type PublicContentPageProps = {
  label: string;
  title: string;
  description: string;
  items: readonly { title: string; description: string }[];
};

export function PublicContentPage({ label, title, description, items }: PublicContentPageProps) {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main>
        <section className="content-hero site-container">
          <p className="section-label">{label}</p>
          <h1>{title}</h1>
          <p>{description}</p>
          <Link className="button button-green" href="/newstudy">
            开始研究 <ArrowRight size={18} />
          </Link>
        </section>
        <section className="content-list section-band">
          <div className="site-container">
            {items.map((item, index) => (
              <article key={item.title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
