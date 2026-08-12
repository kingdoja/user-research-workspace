import { notFound, redirect } from "next/navigation";
import { PanelWorkspace } from "@/components/panel-workspace";
import { getViewer } from "@/lib/auth";
import { getPanel } from "@/lib/studies";

export default async function PanelPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const viewer = await getViewer();

  if (!viewer) {
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(`/panel/${publicId}`)}`);
  }

  const panel = await getPanel(viewer, publicId);
  if (!panel) notFound();

  return <PanelWorkspace panel={panel} viewer={viewer} />;
}
