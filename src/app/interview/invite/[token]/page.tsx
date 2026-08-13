import { notFound } from "next/navigation";
import { PublicInterviewForm } from "@/components/public-interview-form";
import { getPublicInterviewInvitation } from "@/lib/interviews";

export const metadata = { title: "参与访谈" };

export default async function PublicInterviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await getPublicInterviewInvitation(token);
  if (!invitation) notFound();
  return <PublicInterviewForm invitation={invitation} />;
}
