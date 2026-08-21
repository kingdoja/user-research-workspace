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
  processAgentRunQueue,
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
const authUserIds = [randomUUID(), randomUUID(), randomUUID()];
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
    const [viewer, outsider, collaboratorPersonal] = viewers;
    await database.query(
      `insert into workspace_members (workspace_id, user_id, role)
       values ($1, $2, 'member')`,
      [viewer.workspaceId, collaboratorPersonal.userId],
    );
    const collaborator = {
      ...collaboratorPersonal,
      workspaceId: viewer.workspaceId,
      workspacePublicId: viewer.workspacePublicId,
      workspaceName: viewer.workspaceName,
      role: "member" as const,
    };
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
    const requestId = `smoke:${suffix}:delivery`;
    const result = await sendAgentMessage(viewer, thread.publicId, {
      content: "Run the governed transformer and save the result.",
      skillPublicIds: [imported.publicId],
      externalExecutionAllowed: true,
      requestId,
    }, {
      maxSteps: 4,
    });
    assert.equal(typeof result, "object");
    if (typeof result !== "object" || "error" in result) throw new Error(`Agent enqueue failed: ${JSON.stringify(result)}`);
    assert.equal(result.status, "queued");
    assert.equal(result.reused, false);
    const replay = await sendAgentMessage(viewer, thread.publicId, {
      content: "Run the governed transformer and save the result.",
      skillPublicIds: [imported.publicId],
      externalExecutionAllowed: true,
      requestId,
    }, { maxSteps: 4 });
    assert.equal(typeof replay, "object");
    if (typeof replay !== "object" || "error" in replay) throw new Error(`Agent replay failed: ${JSON.stringify(replay)}`);
    assert.equal(replay.runPublicId, result.runPublicId);
    assert.equal(replay.reused, true);
    const busy = await sendAgentMessage(viewer, thread.publicId, {
      content: "This second run must not overlap the first one.",
      skillPublicIds: [],
      externalExecutionAllowed: false,
      requestId: `smoke:${suffix}:busy`,
    });
    assert.equal(typeof busy, "object");
    assert.equal(typeof busy === "object" && "error" in busy ? busy.error : null, "busy");
    const processed = await processAgentRunQueue({
      workerId: `universal-agent-smoke:${suffix}`,
      maxRuns: 1,
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
    assert.equal(processed, 1);
    assert.equal(requests.length, 1);
    const workspace = await listUniversalAgentWorkspace(viewer, thread.publicId);
    assert.equal(workspace.messages.at(-1)?.role, "assistant");
    assert.match(workspace.messages.at(-1)?.content ?? "", /已完成/);
    assert.equal(workspace.files[0]?.path, "deliverables/result.json");
    assert.equal(workspace.recentRuns[0]?.status, "completed");
    const sseSteps = await database.query<{ id: string; run_public_id: string; sequence: number }>(
      `select step.id::text as id, run.public_id as run_public_id, step.sequence
       from agent_steps step join agent_runs run on run.id = step.run_id
       join agent_threads thread on thread.id = run.thread_id
       where thread.public_id = $1 and thread.workspace_id = $2 and run.public_id = $3
       order by step.id`,
      [thread.publicId, viewer.workspaceId, result.runPublicId],
    );
    assert.ok(sseSteps.rows.length >= 3);
    assert.ok(sseSteps.rows.every((step) => step.run_public_id === result.runPublicId));
    assert.ok(sseSteps.rows.every((step, index) => index === 0 || BigInt(step.id) > BigInt(sseSteps.rows[index - 1].id)));
    assert.deepEqual(sseSteps.rows.map((step) => step.sequence), [...sseSteps.rows].map((step) => step.sequence).sort((a, b) => a - b));
    const outsiderSseSteps = await database.query<{ id: string }>(
      `select step.id::text as id
       from agent_steps step join agent_runs run on run.id = step.run_id
       join agent_threads thread on thread.id = run.thread_id
       where thread.public_id = $1 and thread.workspace_id = $2 and run.public_id = $3`,
      [thread.publicId, outsider.workspaceId, result.runPublicId],
    );
    assert.equal(outsiderSseSteps.rows.length, 0);
    const file = await getAgentWorkspaceFile(viewer, workspace.files[0].publicId);
    assert.equal(typeof file, "object");
    assert.equal(await getAgentWorkspaceFile(outsider, workspace.files[0].publicId), "not_found");
    assert.equal((await listUniversalAgentWorkspace(outsider)).threads.length, 0);
    await database.query("update skill_manifests set visibility = 'private' where public_id = $1", [imported.publicId]);
    const collaboratorWorkspace = await listUniversalAgentWorkspace(collaborator);
    assert.equal(collaboratorWorkspace.skills.some((skill) => skill.publicId === imported.publicId), false);
    const collaboratorThread = await createAgentThread(collaborator, { title: "Private Skill isolation" });
    assert.equal(typeof collaboratorThread, "object");
    if (typeof collaboratorThread !== "object") throw new Error(`Collaborator thread failed: ${collaboratorThread}`);
    await assert.rejects(
      sendAgentMessage(collaborator, collaboratorThread.publicId, {
        content: "Attempt to bind another member's private Skill.",
        skillPublicIds: [imported.publicId],
        externalExecutionAllowed: true,
        requestId: `smoke:${suffix}:private`,
      }),
      /AGENT_SKILL_NOT_AVAILABLE/,
    );
    const abandoned = await sendAgentMessage(collaborator, collaboratorThread.publicId, {
      content: "Fail cleanly if the initiating member leaves before the worker starts.",
      skillPublicIds: [],
      externalExecutionAllowed: false,
      requestId: `smoke:${suffix}:abandoned`,
    });
    assert.equal(typeof abandoned, "object");
    if (typeof abandoned !== "object" || "error" in abandoned) throw new Error(`Abandoned run enqueue failed: ${JSON.stringify(abandoned)}`);
    await database.query(
      "delete from workspace_members where workspace_id = $1 and user_id = $2",
      [viewer.workspaceId, collaborator.userId],
    );
    assert.equal(await processAgentRunQueue({
      workerId: `universal-agent-smoke:${suffix}:recovery`,
      maxRuns: 1,
      decide: async () => {
        throw new Error("Decision provider must not run for a removed member");
      },
    }), 1);
    const abandonedAudit = await database.query<{ status: string; error_code: string }>(
      "select status, error_code from agent_runs where public_id = $1",
      [abandoned.runPublicId],
    );
    assert.deepEqual(abandonedAudit.rows[0], { status: "failed", error_code: "AGENT_RUN_ACTOR_UNAVAILABLE" });
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

    const limitedThread = await createAgentThread(viewer, { title: "Tool limit governance" });
    assert.equal(typeof limitedThread, "object");
    if (typeof limitedThread !== "object") throw new Error(`Limited thread failed: ${limitedThread}`);
    const limitedRun = await sendAgentMessage(viewer, limitedThread.publicId, {
      content: "Attempt a Skill call after the per-run tool quota is exhausted.",
      skillPublicIds: [imported.publicId],
      externalExecutionAllowed: true,
      requestId: `smoke:${suffix}:tool-limit`,
    }, { maxSteps: 2, maxToolCalls: 0, maxExternalToolCalls: 0 });
    assert.equal(typeof limitedRun, "object");
    if (typeof limitedRun !== "object" || "error" in limitedRun) throw new Error(`Limited run failed: ${JSON.stringify(limitedRun)}`);
    assert.equal(await processAgentRunQueue({
      workerId: `universal-agent-smoke:${suffix}:tool-limit`,
      maxRuns: 1,
      runPublicId: limitedRun.runPublicId,
      decide: async () => ({
        decisionSummary: "Try the bound Skill.", action: "execute_skill" as const,
        message: "Executing.", path: null, content: null, skillPublicId: imported.publicId,
        argumentsJson: JSON.stringify({ value: "must-not-run" }),
        usage: { input_tokens: 50, output_tokens: 20 }, model: "gpt-agent-smoke",
        promptVersion: "smoke", responseId: "resp-tool-limit",
      }),
    }), 1);
    const limitedAudit = await database.query<{
      status: string; error_code: string; tool_calls_used: number; external_tool_calls_used: number;
    }>(
      `select status, error_code, tool_calls_used, external_tool_calls_used
       from agent_runs where public_id = $1`,
      [limitedRun.runPublicId],
    );
    assert.deepEqual(limitedAudit.rows[0], {
      status: "blocked", error_code: "AGENT_TOOL_CALL_LIMIT_EXCEEDED",
      tool_calls_used: 0, external_tool_calls_used: 0,
    });
    assert.equal(requests.length, 1, "blocked Skill call must not reach the sandbox runner");

    const budgetThread = await createAgentThread(viewer, { title: "Token budget governance" });
    assert.equal(typeof budgetThread, "object");
    if (typeof budgetThread !== "object") throw new Error(`Budget thread failed: ${budgetThread}`);
    const budgetRun = await sendAgentMessage(viewer, budgetThread.publicId, {
      content: "Do not start a model turn that cannot fit inside the token budget.",
      skillPublicIds: [], externalExecutionAllowed: false, requestId: `smoke:${suffix}:token-budget`,
    }, { maxSteps: 2, tokenBudget: 100 });
    assert.equal(typeof budgetRun, "object");
    if (typeof budgetRun !== "object" || "error" in budgetRun) throw new Error(`Budget run failed: ${JSON.stringify(budgetRun)}`);
    let budgetDecisionCalls = 0;
    assert.equal(await processAgentRunQueue({
      workerId: `universal-agent-smoke:${suffix}:token-budget`, maxRuns: 1, runPublicId: budgetRun.runPublicId,
      decide: async () => {
        budgetDecisionCalls += 1;
        throw new Error("Token preflight should block before provider invocation");
      },
    }), 1);
    assert.equal(budgetDecisionCalls, 0);
    const budgetAudit = await database.query<{ status: string; error_code: string; input_tokens_used: string; output_tokens_used: string }>(
      `select status, error_code, input_tokens_used::text as input_tokens_used,
              output_tokens_used::text as output_tokens_used from agent_runs where public_id = $1`,
      [budgetRun.runPublicId],
    );
    assert.deepEqual(budgetAudit.rows[0], {
      status: "blocked", error_code: "AGENT_TOKEN_BUDGET_EXCEEDED",
      input_tokens_used: "0", output_tokens_used: "0",
    });
    console.log(JSON.stringify({
      sandboxPackageV2: true, explicitCodeGrant: true, exactSkillBinding: true,
      sandboxRunnerProtocol: "atypica.sandbox/v1", persistentWorkspace: workspace.files[0].path,
      providerRoutingLedger: true, crossWorkspaceIsolation: true, privateSkillIsolation: true,
      idempotentQueue: true, oneActiveRunPerThread: true, claimedSetupFailureRecovered: true,
      sseRunCursorOrdering: true, sseRunFilter: true, sseWorkspaceIsolation: true,
      toolCallGovernance: true, tokenBudgetPreflight: true, blockedRunAudit: true,
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
