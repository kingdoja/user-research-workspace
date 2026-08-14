import { NextResponse } from "next/server";
import { getFollowupProviderStatus, getOpenAIProviderStatus } from "@/lib/openai-provider";
import { getPublicWebSearchStatus } from "@/lib/public-web-search";

export async function GET() {
  const provider = getOpenAIProviderStatus();
  const followup = getFollowupProviderStatus();
  const search = getPublicWebSearchStatus();

  return NextResponse.json({
    status: "ok",
    service: "atypica-rebuild",
    phase: "realtime-interview-agents",
    architecture: {
      runtime: "research-dag-v2",
      skillGateway: "versioned-contracts-v1",
      contextSystem: "lexical-metadata-v1",
      scheduling: "leased-provider-slots-v1",
      experiments: "stable-weighted-assignment-v1",
      realtimeInterviews: "realtime-interview-agent-v1",
      interviewReplay: "versioned-replay-and-human-review-v1",
    },
    providers: {
      model: {
        name: provider.providerName,
        configured: provider.configured,
        planModel: provider.planModel,
        researchModel: provider.researchModel,
        protocol: provider.protocol,
      },
      followup: {
        name: followup.providerName,
        configured: followup.configured,
        model: followup.model,
        protocol: followup.protocol,
        stateMode: followup.stateMode,
      },
      search,
    },
  });
}
