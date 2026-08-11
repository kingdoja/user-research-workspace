import { redirect } from "next/navigation";
import { StudyWorkspace } from "@/components/study-workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listStudies } from "@/lib/studies";

export default async function NewStudyPage() {
  const viewer = await getViewer();

  if (!viewer) {
    redirect("/auth/signin?callbackUrl=%2Fnewstudy");
  }

  const studies = await listStudies(viewer);

  return (
    <WorkspaceShell viewer={viewer}>
      <StudyWorkspace studies={studies} />
    </WorkspaceShell>
  );
}
