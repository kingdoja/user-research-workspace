import { redirect } from "next/navigation";
import { InterviewExperimentWorkspace } from "@/components/interview-experiment-workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getViewer } from "@/lib/auth";
import { listStrategyExperiments } from "@/lib/runtime-control";

export const metadata = { title: "访谈实验" };

export default async function InterviewExperimentsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/signin?callbackUrl=%2Finterview%2Fexperiments");
  const experiments = (await listStrategyExperiments(viewer))
    .filter((experiment) => experiment.workflowType === "realtime_agent");
  return <WorkspaceShell viewer={viewer}>
    <InterviewExperimentWorkspace experiments={experiments} />
  </WorkspaceShell>;
}
