import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  activateRoutingPolicyVersion,
  createRoutingPolicyVersion,
} from "../src/lib/platform-control";
import {
  approveWorkspaceSkillPackage,
  importWorkspaceSkillPackage,
  setWorkspaceSkillEnabled,
} from "../src/lib/skill-gateway";
import {
  createAgentThread,
  getAgentWorkspaceFile,
  listUniversalAgentWorkspace,
  sendAgentMessage,
} from "../src/lib/universal-agent";

if (process.env.UNIVERSAL_AGENT_SMOKE_CONFIRM !== "1") {
  throw new Error("Set UNIVERSAL_AGENT_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Universal Agent smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID()];
const workspaceIds: string[] = [];

async function main() {
  const requests: unknown[] = [];
  const runner = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { protocol?: string; input?: unknown; runtime?: unknown; limits?: unknown };
    requests.push(payload);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      protocol: "atypica.sandbox/v1",
      status: "completed",
      exitCode: 0,
      output: { result: "sandbox-ok", received: payload.input },
    }));
  });
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
  const address = runner.address();
  if (!address || typeof address === "string") throw new Error("Sandbox runner did not bind");
  const endpoint = `http://127.0.0.1:${address.port}/execute`;
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "universal-agent-smoke-key";
  const database = await getDatabase();
  try {
    const viewers = [];
    for (const [index, authUserId] of authUserIds.entries()) {
      await database.query(
        "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)",
        [authUserId, `universal-agent-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `Agent smoke ${index}` })],
      );
      const actor = await database.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string; workspace_name: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id, workspace.name as workspace_name
         from users app_user join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceIds.push(actor.rows[0].workspace_id);
      viewers.push({
        userId: actor.rows[0].user_id, userPublicId: actor.rows[0].user_public_id,
        displayName: `Agent smoke ${index}`, email: `universal-agent-${index}-${suffix}@example.com`,
        workspaceId: actor.rows[0].workspace_id, workspacePublicId: actor.rows[0].workspace_public_id,
        workspaceName: actor.rows[0].workspace_name, role: "owner" as const, tokenBalance: 0,
      });
    }
    const [viewer, outsider] = viewers;
    const imported = await importWorkspaceSkillPackage(viewer, {
      format: "atypica.skill/v2",
      manifest: {
        slug: `sandbox-smoke-${suffix}`,
        name: "Sandbox smoke",
        description: "Runs in an isolated test runner",
        visibility: "workspace",
        capabilities: ["transform.json"],
        requestedCapabilities: ["code_execute"],
        inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        outputSchema: { type: "object", properties: { result: { type: "string" }, received: { type: "object" } }, required: ["result", "received"], additionalProperties: false },
        executor: {
          kind: "sandbox",
          endpoint,
          language: "javascript",
          entrypoint: "index.js",
          files: { "index.js": "export default (input) => ({ result: 'sandbox-ok', received: input });" },
          timeoutMs: 5_000,
          maxResponseBytes: 64_000,
          headersFromEnv: {},
          maxMemoryMb: 64,
          networkAccess: false,
        },
        changeNote: "Universal Agent smoke",
      },
      skillMarkdown: "# Sandbox smoke\n\nTransforms the provided JSON value.",
    });
    assert.equal(typeof imported, "object");
    if (typeof imported !== "object") throw new Error(`Skill import failed: ${imported}`);
    const approval = await approveWorkspaceSkillPackage(viewer, imported.publicId, {
      grants: [{ capability: "code_execute", scope: {} }],
    });
    assert.equal(typeof approval, "object");
    if (typeof approval !== "object") throw new Error(`Skill approval failed: ${approval}`);
    assert.equal(approval.status, "active");
    assert.deepEqual(approval.grantedCapabilities, ["code_execute"]);
    assert.deepEqual(
      await setWorkspaceSkillEnabled(viewer, {
        source: "workspace", slug: `sandbox-smoke-${suffix}`, publicId: imported.publicId, enabled: true,
      }),
      { enabled: true, pinnedVersion: 1 },
    );
    const policy = await createRoutingPolicyVersion(viewer, {
      policyKey: `agent-reasoning-${suffix}`, name: "Agent reasoning smoke", stage: "reasoning", description: "smoke",
      selectionMode: "priority", maxEstimatedCostMicros: 100_000, maxLatencyMs: 60_000,
      minimumQualityTier: "standard", estimatedInputTokens: 800, estimatedOutputTokens: 300,
      changeNote: "smoke", routes: [{
        routeKey: "openai", providerName: "openai", model: "gpt-agent-smoke", protocol: "responses",
        priority: 1, weight: 1, qualityTier: "high", expectedLatencyMs: 1000,
        inputPriceMicrosPerMillion: 1000, outputPriceMicrosPerMillion: 2000,
        pricingSource: "smoke-price", pricingEffectiveAt: "2026-08-17",
      }],
    });
    assert.equal(typeof policy, "object");
    if (typeof policy !== "object") throw new Error(`Policy failed: ${policy}`);
    assert.deepEqual(await activateRoutingPolicyVersion(viewer, policy.versionPublicId), { status: "active" });
    const thread = await createAgentThread(viewer, { title: "Sandbox delivery" });
    assert.equal(typeof thread, "object");
    if (typeof thread !== "object") throw new Error(`Thread failed: ${thread}`);
    let decision = 0;
    const result = await sendAgentMessage(viewer, thread.publicId, {
      content: "Run the governed transformer and save the result.",
      skillPublicIds: [imported.publicId],
      externalExecutionAllowed: true,
    }, {
      maxSteps: 4,
      decide: async () => {
        decision += 1;
        if (decision === 1) return {
          decisionSummary: "Use the selected immutable sandbox Skill.", action: "execute_skill" as const,
          message: "Executing the governed transformer.", path: null, content: null,
          skillPublicId: imported.publicId, argumentsJson: JSON.stringify({ value: "smoke" }),
          usage: { input_tokens: 100, output_tokens: 30 }, model: "gpt-agent-smoke", promptVersion: "smoke", responseId: "resp-1",
        };
        if (decision === 2) return {
          decisionSummary: "Persist the requested deliverable.", action: "write_file" as const,
          message: "Saving the verified result.", path: "deliverables/result.json",
          content: JSON.stringify({ result: "sandbox-ok" }, null, 2), skillPublicId: null, argumentsJson: null,
          usage: { input_tokens: 120, output_tokens: 40 }, model: "gpt-agent-smoke", promptVersion: "smoke", responseId: "resp-2",
        };
        return {
          decisionSummary: "The sandbox result and file are complete.", action: "finish" as const,
          message: "已完成受治理的 Sandbox Skill 执行，并保存结果文件。", path: null, content: null,
          skillPublicId: null, argumentsJson: null, usage: { input_tokens: 80, output_tokens: 25 },
          model: "gpt-agent-smoke", promptVersion: "smoke", responseId: "resp-3",
        };
      },
    });
    assert.equal(typeof result, "object");
    if (typeof result !== "object") throw new Error(`Agent run failed: ${result}`);
    assert.equal(result.status, "completed");
    assert.equal(requests.length, 1);
    const workspace = await listUniversalAgentWorkspace(viewer, thread.publicId);
    assert.equal(workspace.messages.at(-1)?.role, "assistant");
    assert.match(workspace.messages.at(-1)?.content ?? "", /已完成/);
    assert.equal(workspace.files[0]?.path, "deliverables/result.json");
    assert.equal(workspace.recentRuns[0]?.status, "completed");
    const file = await getAgentWorkspaceFile(viewer, workspace.files[0].publicId);
    assert.equal(typeof file, "object");
    assert.equal(await getAgentWorkspaceFile(outsider, workspace.files[0].publicId), "not_found");
    assert.equal((await listUniversalAgentWorkspace(outsider)).threads.length, 0);
    const audit = await database.query<{
      sandbox_status: string; route_status: string; agent_run_id: string; binding_id: string;
    }>(
      `select sandbox.status as sandbox_status, route.status as route_status,
              route.agent_run_id::text as agent_run_id, binding.id::text as binding_id
       from sandbox_executions sandbox
       join agent_runs run on run.id = sandbox.agent_run_id
       join agent_run_skill_bindings binding on binding.run_id = run.id
       join provider_route_decisions route on route.agent_run_id = run.id
       where run.public_id = $1`,
      [result.runPublicId],
    );
    assert.equal(audit.rows[0].sandbox_status, "completed");
    assert.equal(audit.rows[0].route_status, "completed");
    await assert.rejects(
      database.query("update agent_run_skill_bindings set skill_version = 2 where id = $1", [audit.rows[0].binding_id]),
      /AGENT_RUN_SKILL_BINDING_IMMUTABLE/,
    );
    console.log(JSON.stringify({
      sandboxPackageV2: true, explicitCodeGrant: true, exactSkillBinding: true,
      sandboxRunnerProtocol: "atypica.sandbox/v1", persistentWorkspace: workspace.files[0].path,
      providerRoutingLedger: true, crossWorkspaceIsolation: true,
    }, null, 2));
  } finally {
    for (const workspaceId of workspaceIds) await database.query("delete from workspaces where id = $1", [workspaceId]);
    for (const authUserId of authUserIds) await database.query("delete from auth.users where id = $1", [authUserId]);
    if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAIKey;
    await closeDatabase();
    await new Promise<void>((resolve, reject) => runner.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
