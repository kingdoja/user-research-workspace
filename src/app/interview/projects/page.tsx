import { redirect } from "next/navigation";
import { InterviewProjectsWorkspace } from "@/components/interview-projects-workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listInterviewProjects } from "@/lib/interviews";
import { listPersonas, listStudies } from "@/lib/studies";

export const metadata = { title: "访谈项目" };

export default async function InterviewProjectsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/signin?callbackUrl=%2Finterview%2Fprojects");
  const [projects, library, studies] = await Promise.all([
    listInterviewProjects(viewer),
    listPersonas(viewer),
    listStudies(viewer, 100),
  ]);
  return (
    <WorkspaceShell viewer={viewer}>
      <InterviewProjectsWorkspace projects={projects} library={library} studies={studies} />
    </WorkspaceShell>
  );
}
