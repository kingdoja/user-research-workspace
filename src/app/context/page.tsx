import { FileCheck2 } from "lucide-react";
import { redirect } from "next/navigation";
import { ContextAssetWorkspace } from "@/components/context-asset-workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listContextAssets, listContextMemoryPolicies } from "@/lib/context-system";

export const metadata = { title: "Context 资产" };

export default async function ContextPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/signin?callbackUrl=%2Fcontext");
  const [assets, policies] = await Promise.all([
    listContextAssets(viewer),
    listContextMemoryPolicies(viewer),
  ]);

  return (
    <WorkspaceShell viewer={viewer}>
      <div className="workspace-page context-asset-page">
        <div className="workspace-heading-row workspace-page-heading context-asset-heading">
          <div><p className="workspace-eyebrow">RESEARCH MEMORY</p><h1>Context 资产</h1></div>
          <div className="context-governance-state"><FileCheck2 size={17} />可审核·可追溯</div>
        </div>
        <ContextAssetWorkspace
          initialAssets={assets}
          initialPolicies={policies}
          canCreate={viewer.role !== "viewer"}
          canReview={viewer.role === "owner" || viewer.role === "admin"}
        />
      </div>
    </WorkspaceShell>
  );
}
