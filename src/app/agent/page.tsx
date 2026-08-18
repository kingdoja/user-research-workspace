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
        <UniversalAgentWorkspace
          initialWorkspace={workspace}
          canRun={viewer.role !== "viewer"}
        />
      </div>
    </WorkspaceShell>
  );
}
