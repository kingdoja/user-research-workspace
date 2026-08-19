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
  assert.equal(UNIVERSAL_AGENT_PRODUCT_TOOLS.length, 6);
  assert.match(formatUniversalAgentProductToolCatalog(), /persona\.create/);
  assert.match(formatUniversalAgentProductToolCatalog(), /research\.run_confirmed/);

  const denied = await executeUniversalAgentProductTool({
    viewer: fakeViewer,
    toolName: "persona.create",
    arguments: {},
    executionAllowed: false,
  });
  assert.deepEqual(denied, { error: "product_execution_not_confirmed", toolName: "persona.create" });

  const invalid = await executeUniversalAgentProductTool({
    viewer: fakeViewer,
    toolName: "research.run_confirmed",
    arguments: { studyPublicId: "bad" },
    executionAllowed: true,
  });
  assert.equal(invalid.error, "product_tool_input_invalid");

  console.log(JSON.stringify({ catalogCount: UNIVERSAL_AGENT_PRODUCT_TOOLS.length, mutationGate: true, inputValidation: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
