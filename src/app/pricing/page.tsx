import { PricingGrid } from "@/components/pricing-grid";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export default function PricingPage() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main className="pricing-page site-container">
        <h1>价格</h1>
        <p>选择最适合您的方案</p>
        <PricingGrid />
      </main>
      <SiteFooter />
    </div>
  );
}
