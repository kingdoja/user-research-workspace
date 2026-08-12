import { ProductPage } from "@/components/product-page";
import { getViewer } from "@/lib/auth";
import { productPages } from "@/lib/site-data";
import { redirect } from "next/navigation";

export default async function InterviewPage() {
  const viewer = await getViewer();
  if (viewer) redirect("/interview/projects");
  return <ProductPage {...productPages.interview} />;
}
