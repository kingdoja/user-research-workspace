import { NextResponse } from "next/server";
import { getOpenAIProviderStatus } from "@/lib/openai-provider";

export async function GET() {
  const provider = getOpenAIProviderStatus();

  return NextResponse.json({
    status: "ok",
    service: "atypica-rebuild",
    phase: "provider-integration",
    providers: {
      openai: {
        configured: provider.configured,
        planModel: provider.planModel,
        researchModel: provider.researchModel,
      },
    },
  });
}
