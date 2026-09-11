import { ShieldCheck, Users, FileText, Boxes } from "lucide-react";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listAdminStudies, listAdminUsers } from "@/lib/admin";
import { formatStudyDate, studyStatusLabels, studyTypeLabels } from "@/lib/study-display";

export const metadata = { title: "平台管理员" };

export default async function AdminPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/signin?callbackUrl=%2Fadmin");
  if (!viewer.isPlatformAdmin) redirect("/studies");

  const [users, studies] = await Promise.all([listAdminUsers(viewer), listAdminStudies(viewer)]);
  const reportCount = studies.filter((study) => study.report).length;
  const artifactCount = studies.reduce((total, study) => total + study.artifactCount, 0);

  return (
    <WorkspaceShell viewer={viewer}>
      <div className="workspace-page admin-page">
        <div className="workspace-heading-row workspace-page-heading">
          <div><span className="admin-eyebrow"><ShieldCheck size={14} /> PLATFORM ADMIN</span><h1>全局研究总览</h1><p>跨工作区只读查看用户、研究项目、报告和研究产物。</p></div>
        </div>
        <div className="admin-summary-grid">
          <section><Users size={19} /><span>用户</span><strong>{users.length}</strong><small>已注册账户</small></section>
          <section><FileText size={19} /><span>研究项目</span><strong>{studies.length}</strong><small>{reportCount} 份已生成报告</small></section>
          <section><Boxes size={19} /><span>研究产物</span><strong>{artifactCount}</strong><small>来自所有工作区</small></section>
        </div>
        <section className="admin-section"><header><h2>研究项目与报告</h2><span>{studies.length} 个项目</span></header><div className="study-table-wrap"><table className="study-table admin-study-table"><thead><tr><th>项目</th><th>创建者</th><th>工作区</th><th>状态</th><th>报告</th><th>产物</th><th>更新时间</th></tr></thead><tbody>{studies.map((study) => <tr key={study.publicId}><td><strong>{study.title}</strong><small>{study.brief}</small></td><td><strong>{study.creatorName}</strong><small>{study.creatorEmail}</small></td><td>{study.workspaceName}</td><td><span className={`study-status status-${study.status}`}>{studyStatusLabels[study.status] ?? study.status}</span></td><td>{study.report ? <details className="admin-report-details"><summary>{study.report.title}</summary><p>{study.report.description}</p><ReportContent content={study.report.content} /></details> : <span className="admin-muted">未生成</span>}</td><td>{study.artifactCount}</td><td>{formatStudyDate(study.updatedAt)}</td></tr>)}</tbody></table></div>{studies.length === 0 ? <p className="admin-empty">还没有研究项目。</p> : null}</section>
        <section className="admin-section"><header><h2>用户账户</h2><span>{users.length} 位用户</span></header><div className="study-table-wrap"><table className="study-table admin-users-table"><thead><tr><th>用户</th><th>工作区</th><th>研究</th><th>报告</th><th>注册时间</th></tr></thead><tbody>{users.map((user) => <tr key={user.publicId}><td><strong>{user.displayName}</strong><small>{user.email}</small></td><td>{user.workspaceCount}</td><td>{user.studyCount}</td><td>{user.reportCount}</td><td>{formatStudyDate(user.createdAt)}</td></tr>)}</tbody></table></div></section>
      </div>
    </WorkspaceShell>
  );
}

function ReportContent({ content }: { content: Record<string, unknown> }) {
  const executiveSummary = typeof content.executiveSummary === "string" ? content.executiveSummary : "";
  const findings = Array.isArray(content.findings) ? content.findings.filter((item): item is { title?: string; insight?: string } => Boolean(item && typeof item === "object")) : [];
  return <div className="admin-report-content">{executiveSummary ? <p>{executiveSummary}</p> : null}{findings.length ? <ol>{findings.slice(0, 5).map((finding, index) => <li key={`${finding.title ?? "finding"}-${index}`}><strong>{finding.title ?? `洞察 ${index + 1}`}</strong>{finding.insight ? <span>{finding.insight}</span> : null}</li>)}</ol> : null}</div>;
}
