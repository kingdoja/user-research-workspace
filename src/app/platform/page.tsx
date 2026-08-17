import { Network } from "lucide-react";
import { redirect } from "next/navigation";
import { PlatformControlWorkspace } from "@/components/platform-control-workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listCollaboration, listRoutingControl } from "@/lib/platform-control";

export const metadata = { title: "平台控制" };

export default async function PlatformPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/signin?callbackUrl=%2Fplatform");
  const [collaboration, routing] = await Promise.all([listCollaboration(viewer), listRoutingControl(viewer)]);
  return (
    <WorkspaceShell viewer={viewer}>
      <div className="workspace-page platform-page">
        <div className="workspace-heading-row workspace-page-heading">
          <div><span className="platform-eyebrow"><Network size={14} /> PLATFORM CONTROL</span><h1>协作与路由</h1><p>跨工作区发布、委托和 Provider 策略的版本化控制面。</p></div>
        </div>
        <PlatformControlWorkspace initialCollaboration={collaboration} initialRouting={routing} canManage={viewer.role === "owner" || viewer.role === "admin"} />
      </div>
    </WorkspaceShell>
  );
}
