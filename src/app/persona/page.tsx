import { ProductPage } from "@/components/product-page";
import { productPages } from "@/lib/site-data";

export default function PersonaPage() {
  return <ProductPage {...productPages.persona} />;
}
