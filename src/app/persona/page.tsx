import { ProductPage } from "@/components/product-page";
import { PersonaLibrary } from "@/components/persona-library";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { productPages } from "@/lib/site-data";
import { listPersonas } from "@/lib/studies";

export default async function PersonaPage() {
  const viewer = await getViewer();
  if (!viewer) return <ProductPage {...productPages.persona} />;
  const library = await listPersonas(viewer);
  return <WorkspaceShell viewer={viewer}><PersonaLibrary initialData={library} /></WorkspaceShell>;
}
