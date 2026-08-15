import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  createWorkspaceSkill,
  executeWorkspaceSkill,
  getRunSkillBinding,
  listSkillCatalog,
  lockRunBuiltInSkills,
  setWorkspaceSkillEnabled,
} from "../src/lib/skill-gateway";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.SKILL_EXECUTOR_SMOKE_CONFIRM !== "1") {
  throw new Error("Set SKILL_EXECUTOR_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Skill executor smoke test only runs against a local database.");
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : undefined;
}

function createTestServer() {
  return createServer(async (request, response) => {
    if (request.url === "/http" && request.method === "POST") {
      const body = await readBody(request) as { message?: string };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ echoed: body.message ?? "" }));
      return;
    }
    if (request.url === "/mcp" && request.method === "POST") {
      const mcp = new McpServer({ name: "skill-executor-smoke", version: "1.0.0" });
      mcp.registerTool(
        "echo_signal",
        { inputSchema: { message: z.string() } },
        async ({ message }) => ({ content: [{ type: "text" as const, text: JSON.stringify({ signal: message.toUpperCase() }) }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response, await readBody(request));
      } catch (error) {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "MCP failure" }));
      } finally {
        await transport.close().catch(() => undefined);
        await mcp.close().catch(() => undefined);
      }
      return;
    }
    response.writeHead(404).end();
  });
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID()];
const workspaceIds: string[] = [];

async function main() {
  const httpServer = createTestServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const database = await getDatabase();
  try {
    const viewers = [];
    for (const [index, authUserId] of authUserIds.entries()) {
      await database.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, $3::jsonb)`,
        [authUserId, `skill-executor-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `Skill smoke ${index}` })],
      );
      const actor = await database.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string; workspace_name: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id,
                workspace.name as workspace_name
         from users app_user
         join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceIds.push(actor.rows[0].workspace_id);
      viewers.push({
        userId: actor.rows[0].user_id,
        userPublicId: actor.rows[0].user_public_id,
        displayName: `Skill smoke ${index}`,
        email: `skill-executor-${index}-${suffix}@example.com`,
        workspaceId: actor.rows[0].workspace_id,
        workspacePublicId: actor.rows[0].workspace_public_id,
        workspaceName: actor.rows[0].workspace_name,
        role: "owner" as const,
        tokenBalance: 0,
      });
    }
    const [viewer, otherViewer] = viewers;
    const common = {
      description: "Skill executor smoke",
      visibility: "workspace" as const,
      capabilities: ["smoke.echo"],
      inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } }, additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true },
    };
    const httpSkill = await createWorkspaceSkill(viewer, {
      ...common,
      slug: `http-echo-${suffix}`,
      name: "HTTP Echo",
      executor: {
        kind: "declarative_http",
        endpoint: `${origin}/http`,
        method: "POST",
        timeoutMs: 5_000,
        maxResponseBytes: 16_384,
        headersFromEnv: {},
      },
    });
    assert.equal(typeof httpSkill, "object");
    if (typeof httpSkill !== "object") throw new Error(`HTTP skill creation failed: ${httpSkill}`);
    const mcpSkill = await createWorkspaceSkill(viewer, {
      ...common,
      slug: `mcp-echo-${suffix}`,
      name: "MCP Echo",
      executor: {
        kind: "mcp",
        endpoint: `${origin}/mcp`,
        toolName: "echo_signal",
        timeoutMs: 5_000,
        maxResponseBytes: 16_384,
        headersFromEnv: {},
      },
    });
    assert.equal(typeof mcpSkill, "object");
    if (typeof mcpSkill !== "object") throw new Error(`MCP skill creation failed: ${mcpSkill}`);

    const before = await listSkillCatalog(viewer, []);
    assert(before.every((skill) => !skill.enabled));
    assert.deepEqual(
      await setWorkspaceSkillEnabled(viewer, { source: "workspace", slug: `http-echo-${suffix}`, publicId: httpSkill.publicId, enabled: true }),
      { enabled: true, pinnedVersion: 1 },
    );
    assert.deepEqual(
      await setWorkspaceSkillEnabled(viewer, { source: "workspace", slug: `mcp-echo-${suffix}`, publicId: mcpSkill.publicId, enabled: true }),
      { enabled: true, pinnedVersion: 1 },
    );
    const httpResult = await executeWorkspaceSkill(viewer, httpSkill.publicId, { message: "hello" });
    assert.equal(typeof httpResult, "object");
    if (typeof httpResult !== "object") throw new Error(`HTTP execution failed: ${httpResult}`);
    assert.deepEqual(httpResult.output, { echoed: "hello" });
    const mcpResult = await executeWorkspaceSkill(viewer, mcpSkill.publicId, { message: "signal" });
    assert.equal(typeof mcpResult, "object");
    if (typeof mcpResult !== "object") throw new Error(`MCP execution failed: ${mcpResult}`);
    assert.deepEqual(mcpResult.output, { signal: "SIGNAL" });
    await assert.rejects(
      executeWorkspaceSkill(viewer, httpSkill.publicId, { unknown: true }),
      /不符合 Skill schema/,
    );
    assert.equal(await executeWorkspaceSkill(otherViewer, httpSkill.publicId, { message: "hidden" }), "not_found");
    await setWorkspaceSkillEnabled(viewer, { source: "workspace", slug: `http-echo-${suffix}`, publicId: httpSkill.publicId, enabled: false });
    assert.equal(await executeWorkspaceSkill(viewer, httpSkill.publicId, { message: "disabled" }), "disabled");

    await setWorkspaceSkillEnabled(viewer, { source: "builtin", slug: "designStudy", publicId: null, enabled: false });
    const study = await database.query<{ id: string }>(
      `insert into studies (
         public_id, workspace_id, created_by, title, brief, study_type,
         status, current_stage, estimated_tokens
       ) values ($1, $2, $3, 'Skill binding smoke', '验证 Skill 绑定', 'user_research',
                 'awaiting_confirmation', 'confirmation', 1000)
       returning id::text as id`,
      [`std_skill_${suffix}`, viewer.workspaceId, viewer.userId],
    );
    const planVersion = await createSmokePlanVersion(database, study.rows[0].id, viewer.userId);
    const run = await database.query<{ id: string }>(
      `insert into study_runs (study_id, plan_version_id, status)
       values ($1, $2, 'queued') returning id::text as id`,
      [study.rows[0].id, planVersion.id],
    );
    await lockRunBuiltInSkills({
      queryable: database,
      workspaceId: viewer.workspaceId,
      studyId: study.rows[0].id,
      runId: run.rows[0].id,
      skills: [{ slug: "designStudy", version: 1 }],
    });
    const binding = await getRunSkillBinding(run.rows[0].id, "designStudy");
    assert(binding);
    assert.equal(binding.enabledAtLock, false);
    await assert.rejects(
      database.query("update study_run_skill_bindings set enabled_at_lock = true where id = $1", [binding.id]),
      /RUN_SKILL_BINDING_IMMUTABLE/,
    );

    const audit = await database.query<{ completed: number; failed: number; events: number }>(
      `select
         (select count(*)::int from skill_executions where workspace_id = $1 and status = 'completed') as completed,
         (select count(*)::int from skill_executions where workspace_id = $1 and status = 'failed') as failed,
         (select count(*)::int from skill_control_events where workspace_id = $1) as events`,
      [viewer.workspaceId],
    );
    assert.equal(audit.rows[0].completed, 2);
    assert.equal(audit.rows[0].failed, 1);
    assert.equal(audit.rows[0].events, 4);
    console.log(JSON.stringify({
      executors: ["declarative_http", "mcp"],
      completedExecutions: audit.rows[0].completed,
      failedSchemaExecutions: audit.rows[0].failed,
      controlEvents: audit.rows[0].events,
      runBinding: `${binding.slug}@${binding.version}`,
      disabledAtLock: !binding.enabledAtLock,
      immutable: true,
      crossWorkspaceHidden: true,
    }, null, 2));
  } finally {
    for (const workspaceId of workspaceIds) await database.query("delete from workspaces where id = $1", [workspaceId]);
    for (const authUserId of authUserIds) await database.query("delete from auth.users where id = $1", [authUserId]);
    await closeDatabase();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
