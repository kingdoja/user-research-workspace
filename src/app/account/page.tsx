import { Coins, KeyRound, UsersRound } from "lucide-react";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { formatTokens } from "@/lib/study-display";

export const metadata = { title: "账户中心" };

export default async function AccountPage() {
  const viewer = await getViewer();

  if (!viewer) {
    redirect("/auth/signin?callbackUrl=%2Faccount");
  }

  return (
    <WorkspaceShell viewer={viewer}>
      <div className="workspace-page account-page">
        <div className="workspace-heading-row workspace-page-heading">
          <div><h1>账户中心</h1><p>本地恢复环境的账户与工作区信息。</p></div>
        </div>
        <div className="account-summary-grid">
          <section><Coins size={20} /><span>Token 余额</span><strong>{formatTokens(viewer.tokenBalance)}</strong><p>当前为本地恢复数据，不会自动扣费。</p></section>
          <section><UsersRound size={20} /><span>工作区</span><strong>{viewer.workspaceName}</strong><p>{viewer.role === "owner" ? "所有者" : viewer.role}</p></section>
          <section><KeyRound size={20} /><span>API 与模型</span><strong>尚未配置</strong><p>接入执行引擎时再配置提供商凭据。</p></section>
        </div>
      </div>
    </WorkspaceShell>
  );
}
