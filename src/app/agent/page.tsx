import { Command } from "lucide-react";
import { redirect } from "next/navigation";
import { UniversalAgentWorkspace } from "@/components/universal-agent-workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listUniversalAgentWorkspace } from "@/lib/universal-agent";

export const metadata = { title: "Universal Agent" };

export default async function AgentPage({ searchParams }: { searchParams: Promise<{ thread?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/signin?callbackUrl=%2Fagent");
  const params = await searchParams;
  const workspace = await listUniversalAgentWorkspace(viewer, params.thread);
  return (
    <WorkspaceShell viewer={viewer}>
      <div className="workspace-page universal-agent-page">
        <div className="workspace-heading-row workspace-page-heading universal-agent-heading">
          <div><p className="workspace-eyebrow"><Command size={14} /> UNIVERSAL AGENT</p><h1>通用工作台</h1></div>
          <div className={workspace.provider.configured ? "agent-provider-state ready" : "agent-provider-state"}>
            <span />{workspace.provider.providerName} / {workspace.provider.model}
          </div>
        </div>
        <UniversalAgentWorkspace
          initialWorkspace={workspace}
          canRun={viewer.role !== "viewer"}
        />
      </div>
    </WorkspaceShell>
  );
}
