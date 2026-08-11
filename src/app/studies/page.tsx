import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { StudiesBrowser } from "@/components/studies-browser";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listStudies } from "@/lib/studies";

export const metadata = { title: "研究项目" };

export default async function StudiesPage() {
  const viewer = await getViewer();

  if (!viewer) {
    redirect("/auth/signin?callbackUrl=%2Fstudies");
  }

  const studies = await listStudies(viewer, 100);

  return (
    <WorkspaceShell viewer={viewer}>
      <div className="workspace-page">
        <div className="workspace-heading-row workspace-page-heading">
          <div>
            <h1>研究项目</h1>
            <p>查看研究计划、执行状态与后续报告。</p>
          </div>
          <Link className="button button-green" href="/newstudy"><FlaskConical size={17} />新研究</Link>
        </div>
        <StudiesBrowser studies={studies} />
      </div>
    </WorkspaceShell>
  );
}
