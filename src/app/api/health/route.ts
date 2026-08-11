import { NextResponse } from "next/server";
import { getOpenAIProviderStatus } from "@/lib/openai-provider";
import { getPublicWebSearchStatus } from "@/lib/public-web-search";

export async function GET() {
  const provider = getOpenAIProviderStatus();
  const search = getPublicWebSearchStatus();

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
      search,
    },
  });
}
