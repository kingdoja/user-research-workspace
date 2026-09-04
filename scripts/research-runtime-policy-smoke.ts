import assert from "node:assert/strict";

async function main() {
  process.env.RESEARCH_ENGINE = "gpt-researcher";
  process.env.GPT_RESEARCHER_TASK_TIMEOUT_SECONDS = "900";

  const { resolveResearchTaskRuntimePolicy } = await import("../src/lib/research-harness");
  const { classifyTaskError } = await import("../src/lib/task-recovery");

  assert.deepEqual(resolveResearchTaskRuntimePolicy({
    toolName: "scoutSocialTrends",
    persistedTimeoutSeconds: 300,
  }), {
    timeoutSeconds: 300,
    researchEngine: "local",
  });

  assert.deepEqual(resolveResearchTaskRuntimePolicy({
    toolName: "deepResearch",
    persistedTimeoutSeconds: 300,
  }), {
    timeoutSeconds: 900,
    researchEngine: "gpt-researcher",
  });

  assert.deepEqual(resolveResearchTaskRuntimePolicy({
    toolName: "deepResearch",
    persistedTimeoutSeconds: 300,
    strategyConfig: { taskTimeoutSeconds: 240 },
  }), {
    timeoutSeconds: 240,
    researchEngine: "gpt-researcher",
  });

  process.env.RESEARCH_ENGINE = "local";
  assert.deepEqual(resolveResearchTaskRuntimePolicy({
    toolName: "deepResearch",
    persistedTimeoutSeconds: 300,
  }), {
    timeoutSeconds: 300,
    researchEngine: "local",
  });

  assert.deepEqual(
    {
      disposition: classifyTaskError(new Error("GPT_RESEARCHER_IDLE_TIMEOUT")).disposition,
      retryable: classifyTaskError(new Error("GPT_RESEARCHER_IDLE_TIMEOUT")).retryable,
      missingTokenDisposition: classifyTaskError(new Error("GPT_RESEARCHER_BRIDGE_TOKEN_MISSING")).disposition,
    },
    { disposition: "retry", retryable: true, missingTokenDisposition: "terminal" },
  );

  console.log(JSON.stringify({
    scoutEngine: "local",
    deepResearchEngine: "gpt-researcher",
    gptResearcherDefaultTimeoutSeconds: 900,
    strategyOverridePreserved: true,
    failureClassificationVerified: true,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
