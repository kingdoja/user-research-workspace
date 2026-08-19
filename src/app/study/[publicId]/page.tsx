import { notFound, redirect } from "next/navigation";
import { StudyAgentWorkspace } from "@/components/study-agent-workspace";
import { getViewer } from "@/lib/auth";
import { getOpenAIProviderStatus } from "@/lib/openai-provider";
import { getStudy } from "@/lib/studies";

export default async function StudyDetailPage({ params }: PageProps<"/study/[publicId]">) {
  const { publicId } = await params;
  const viewer = await getViewer();

  if (!viewer) {
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(`/study/${publicId}`)}`);
  }

  const study = await getStudy(viewer, publicId);

  if (!study) {
    notFound();
  }

  return (
    <StudyAgentWorkspace
      study={study}
      viewer={viewer}
      provider={getOpenAIProviderStatus()}
    />
  );
}
