import assert from "node:assert/strict";
import {
  executeUniversalAgentProductTool,
  formatUniversalAgentProductToolCatalog,
  UNIVERSAL_AGENT_PRODUCT_TOOLS,
} from "@/lib/universal-agent-product-tools";

const fakeViewer = {
  userId: "1",
  userPublicId: "usr_smoke",
  workspaceId: "1",
  workspacePublicId: "wsp_smoke",
  workspaceName: "smoke",
  role: "member",
  email: "smoke@example.com",
  tokenBalance: 1_000_000,
} as never;

async function main() {
  assert.equal(UNIVERSAL_AGENT_PRODUCT_TOOLS.length, 7);
  assert.match(formatUniversalAgentProductToolCatalog(), /web\.search/);
  assert.match(formatUniversalAgentProductToolCatalog(), /persona\.create/);
  assert.match(formatUniversalAgentProductToolCatalog(), /research\.run_confirmed/);

  const denied = await executeUniversalAgentProductTool({
    viewer: fakeViewer,
    toolName: "persona.create",
    arguments: {},
    executionAllowed: false,
  });
  assert.equal(denied.status, "blocked");
  assert.equal(denied.error, "product_execution_not_confirmed");
  assert.equal(denied.resourceType, "product_tool");
  assert.equal(denied.resourcePublicId, null);
  assert.equal(denied.href, null);
  assert.equal(typeof denied.summary, "string");
  assert.equal(typeof denied.nextAction, "string");

  const invalid = await executeUniversalAgentProductTool({
    viewer: fakeViewer,
    toolName: "research.run_confirmed",
    arguments: { studyPublicId: "bad" },
    executionAllowed: true,
  });
  assert.equal(invalid.error, "product_tool_input_invalid");
  assert.equal(invalid.status, "invalid");
  for (const key of ["status", "resourceType", "resourcePublicId", "href", "summary", "nextAction"] as const) {
    assert.ok(key in invalid, `missing normalized result field: ${key}`);
  }

  console.log(JSON.stringify({ catalogCount: UNIVERSAL_AGENT_PRODUCT_TOOLS.length, mutationGate: true, inputValidation: true, normalizedOutput: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
