import { notFound, redirect } from "next/navigation";
import { InterviewProjectWorkspace } from "@/components/interview-project-workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { getInterviewProject } from "@/lib/interviews";

export default async function InterviewProjectPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const viewer = await getViewer();
  if (!viewer) redirect(`/auth/signin?callbackUrl=${encodeURIComponent(`/interview/projects/${publicId}`)}`);
  const project = await getInterviewProject(viewer, publicId);
  if (!project) notFound();
  return <WorkspaceShell viewer={viewer}><InterviewProjectWorkspace project={project} /></WorkspaceShell>;
}
