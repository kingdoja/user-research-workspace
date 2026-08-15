import { Blocks, Cable, LockKeyhole, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { SkillControlPanel } from "@/components/skill-control-panel";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listResearchSkills } from "@/lib/research-harness";
import { REALTIME_INTERVIEW_SKILL } from "@/lib/realtime-interviews";
import { listSkillCatalog } from "@/lib/skill-gateway";

export const metadata = { title: "Skill Gateway" };

export default async function SkillsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/signin?callbackUrl=%2Fskills");
  const skills = await listSkillCatalog(viewer, [
    ...listResearchSkills(),
    {
      publicId: null,
      slug: REALTIME_INTERVIEW_SKILL.slug,
      version: REALTIME_INTERVIEW_SKILL.version,
      name: "实时访谈 Agent",
      description: "逐轮提问、追问、持久化恢复与访谈质量评估。",
      capabilities: ["interview.realtime", "interview.followup", "interview.replay"],
      source: "builtin",
      status: "active",
      executable: true,
      enabled: true,
      executorType: "builtin",
      contentHash: null,
    },
  ]);
  const enabled = skills.filter((skill) => skill.enabled).length;
  const remote = skills.filter((skill) => skill.source === "workspace" && skill.executable).length;

  return (
    <WorkspaceShell viewer={viewer}>
      <div className="workspace-page skill-gateway-page">
        <div className="workspace-heading-row workspace-page-heading skill-gateway-heading">
          <div><p className="workspace-eyebrow">EXECUTION CONTROL</p><h1>Skill Gateway</h1></div>
          <div className="skill-gateway-health"><ShieldCheck size={17} />受控执行</div>
        </div>
        <section className="skill-gateway-metrics" aria-label="Skill Gateway 状态">
          <div><Blocks size={18} /><span>已注册</span><strong>{skills.length}</strong></div>
          <div><LockKeyhole size={18} /><span>已启用</span><strong>{enabled}</strong></div>
          <div><Cable size={18} /><span>远程 Executor</span><strong>{remote}</strong></div>
        </section>
        <SkillControlPanel
          key={skills.map((skill) => `${skill.source}:${skill.slug}@${skill.version}`).join("|")}
          initialSkills={skills}
          canManageBuiltins={viewer.role === "owner" || viewer.role === "admin"}
          canCreate={viewer.role !== "viewer"}
        />
      </div>
    </WorkspaceShell>
  );
}
