import { ProductPage } from "@/components/product-page";
import { productPages } from "@/lib/site-data";

export default function SagePage() {
  return <ProductPage {...productPages.sage} />;
}
