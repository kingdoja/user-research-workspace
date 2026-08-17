import { NextResponse } from "next/server";
import { getContextEmbeddingProviderStatus } from "@/lib/context-system";
import { getFollowupProviderStatus, getOpenAIProviderStatus } from "@/lib/openai-provider";
import { getPublicWebSearchStatus } from "@/lib/public-web-search";

export async function GET() {
  const provider = getOpenAIProviderStatus();
  const followup = getFollowupProviderStatus();
  const search = getPublicWebSearchStatus();

  return NextResponse.json({
    status: "ok",
    service: "atypica-rebuild",
    phase: "agent-eval-dynamic-context-v1",
    architecture: {
      runtime: "workflow-definition-runtime-v1",
      productLines: ["research", "market_insight"],
      workflowTypes: ["realtime_agent", "batch_research", "market_insight"],
      skillGateway: "governed-skill-package-v3",
      skillExecutors: ["builtin", "declarative-http", "mcp-streamable-http"],
      skillPackages: "atypica.skill/v1-submitted-grant-revoke-health",
      contextSystem: "hybrid-v1-with-purpose-bound-memory-policy-and-replayable-refresh",
      agentEval: "authorized-sources-human-labels-deterministic-judge-v1",
      scheduling: "leased-provider-slots-v1",
      experiments: "stable-weighted-assignment-v1",
      realtimeInterviews: "realtime-interview-agent-v1",
      interviewReplay: "versioned-replay-and-human-review-v1",
      studyRunReplay: "plan-version-run-replay-v1",
      intentService: "research-intent-v1-with-governed-context",
      workflowDefinition: "workflow-definition-v1",
    },
    providers: {
      model: {
        name: provider.providerName,
        configured: provider.configured,
        requiredVariable: provider.requiredVariable,
        planProvider: provider.planProviderName,
        planConfigured: provider.planConfigured,
        planModel: provider.planModel,
        planProtocol: provider.planProtocol,
        researchProvider: provider.researchProviderName,
        researchConfigured: provider.researchConfigured,
        researchModel: provider.researchModel,
        researchProtocol: provider.researchProtocol,
        reasoningProvider: provider.reasoningProviderName,
        reasoningConfigured: provider.reasoningConfigured,
        reasoningModel: provider.reasoningModel,
        reasoningProtocol: provider.reasoningProtocol,
        reportProvider: provider.reportProviderName,
        reportConfigured: provider.reportConfigured,
        reportModel: provider.reportModel,
        reportProtocol: provider.reportProtocol,
        judgeProvider: provider.judgeProviderName,
        judgeConfigured: provider.judgeConfigured,
        judgeModel: provider.judgeModel,
        judgeProtocol: provider.judgeProtocol,
        protocol: provider.protocol,
      },
      followup: {
        name: followup.providerName,
        configured: followup.configured,
        model: followup.model,
        protocol: followup.protocol,
        stateMode: followup.stateMode,
      },
      contextEmbedding: getContextEmbeddingProviderStatus(),
      search,
    },
  });
}
