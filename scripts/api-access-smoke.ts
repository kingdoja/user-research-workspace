import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Viewer } from "../src/lib/auth";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { createStudy } from "../src/lib/studies";

if (process.env.API_ACCESS_SMOKE_CONFIRM !== "1") {
  throw new Error("Set API_ACCESS_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("API access smoke test only runs against a local database.");
}
process.env.OPENAI_API_KEY = "";
process.env.DEEPSEEK_API_KEY = "";

type ApiKeyScope = "studies:read" | "studies:write";

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID()];
const workspaceIds: string[] = [];
let nextProcess: ChildProcess | null = null;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PORT_UNAVAILABLE");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startNextServer() {
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  nextProcess = spawn("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_SSL_MODE: "disable" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  nextProcess.stdout?.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12_000); });
  nextProcess.stderr?.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12_000); });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (nextProcess.exitCode !== null) throw new Error(`NEXT_SERVER_EXITED\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return baseUrl;
    } catch {
      // The server socket is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`NEXT_SERVER_START_TIMEOUT\n${output}`);
}

async function stopNextServer() {
  const child = nextProcess;
  nextProcess = null;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function seedKey(
  viewer: Viewer,
  name: string,
  scopes: ApiKeyScope[],
  state: "active" | "expired" | "revoked" = "active",
) {
  const database = await getDatabase();
  const publicId = `key_${randomUUID().replaceAll("-", "")}`;
  const secret = `atypica_sk_${randomBytes(32).toString("base64url")}`;
  await database.query(
    `insert into workspace_api_keys (
       public_id, workspace_id, created_by, name, secret_prefix, secret_hash,
       scopes, expires_at, revoked_at, revoked_by, created_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7::text[],
       case when $8 = 'expired' then now() - interval '1 day' else now() + interval '90 days' end,
       case when $8 = 'revoked' then now() else null end,
       case when $8 = 'revoked' then $3::bigint else null end,
       now() - interval '2 days'
     )`,
    [publicId, viewer.workspaceId, viewer.userId, name, `${secret.slice(0, 16)}...`, sha256(secret), scopes, state],
  );
  return { publicId, secret };
}

function apiHeaders(token?: string, body = false) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body) headers.set("content-type", "application/json");
  return headers;
}

async function callMcp(baseUrl: string, token: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return JSON.parse(raw) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };
}

async function main() {
  const database = await getDatabase();
  try {
    const actors = await database.transaction(async (transaction) => {
      for (const [index, authUserId] of authUserIds.entries()) {
        await transaction.query(
          `insert into auth.users (id, email, raw_user_meta_data)
           values ($1, $2, $3::jsonb)`,
          [authUserId, `api-access-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `API access smoke ${index}` })],
        );
      }
      return (await transaction.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string;
        workspace_name: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id,
                workspace.name as workspace_name
         from users app_user
         join workspace_members member on member.user_id = app_user.id and member.role = 'owner'
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = any($1::uuid[])
         order by app_user.email`,
        [authUserIds],
      )).rows;
    });
    workspaceIds.push(...actors.map((actor) => actor.workspace_id));
    const viewers = actors.map((actor, index): Viewer => ({
      userId: actor.user_id,
      userPublicId: actor.user_public_id,
      displayName: `API access smoke ${index}`,
      email: `api-access-${index}-${suffix}@example.com`,
      workspaceId: actor.workspace_id,
      workspacePublicId: actor.workspace_public_id,
      workspaceName: actor.workspace_name,
      role: "owner",
      tokenBalance: 0,
    }));
    const viewer = viewers[0];
    const otherViewer = viewers[1];
    const ownStudy = await createStudy(viewer, `验证 ${suffix} 工作区 API 读取隔离和审计行为。`);
    const otherStudy = await createStudy(otherViewer, `验证 ${suffix} 其他工作区数据不会泄露。`);
    const readKey = await seedKey(viewer, "Read studies", ["studies:read"]);
    const writeKey = await seedKey(viewer, "Write studies", ["studies:write"]);
    const mcpKey = await seedKey(viewer, "MCP studies", ["studies:read"]);
    const revokedKey = await seedKey(viewer, "Revoked studies", ["studies:read"], "revoked");
    const expiredKey = await seedKey(viewer, "Expired studies", ["studies:read"], "expired");
    const removedMemberKey = await seedKey(viewer, "Removed member", ["studies:read"]);

    const stored = await database.query<{ secret_hash: string; secret_prefix: string }>(
      "select secret_hash, secret_prefix from workspace_api_keys where public_id = $1",
      [readKey.publicId],
    );
    assert.equal(stored.rows[0].secret_hash, sha256(readKey.secret));
    assert.notEqual(stored.rows[0].secret_hash, readKey.secret);
    assert(!stored.rows[0].secret_prefix.includes(readKey.secret));

    const baseUrl = await startNextServer();
    const missing = await fetch(`${baseUrl}/api/v1/studies`);
    assert.equal(missing.status, 401);

    const listed = await fetch(`${baseUrl}/api/v1/studies`, { headers: apiHeaders(readKey.secret) });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { data: Array<{ publicId: string }> };
    assert(listedBody.data.some((study) => study.publicId === ownStudy));
    assert(!listedBody.data.some((study) => study.publicId === otherStudy));
    assert.equal(listed.headers.get("cache-control"), "no-store");
    assert(listed.headers.get("x-request-id"));

    const deniedCreate = await fetch(`${baseUrl}/api/v1/studies`, {
      method: "POST",
      headers: apiHeaders(readKey.secret, true),
      body: JSON.stringify({ brief: `这个请求 ${suffix} 不应越过 studies:write 权限。` }),
    });
    assert.equal(deniedCreate.status, 403);

    const created = await fetch(`${baseUrl}/api/v1/studies`, {
      method: "POST",
      headers: apiHeaders(writeKey.secret, true),
      body: JSON.stringify({ brief: `通过外部 API 创建 ${suffix} 研究并验证返回契约。` }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { data: { publicId: string; status: string } };
    assert(createdBody.data.publicId);
    assert.equal(createdBody.data.status, "planning");

    const mcpList = await callMcp(baseUrl, mcpKey.secret, "tools/call", {
      name: "list_studies",
      arguments: { limit: 10 },
    });
    assert(!mcpList.error);
    assert.equal(mcpList.result?.isError, undefined);
    const mcpStudies = JSON.parse(mcpList.result?.content?.[0]?.text ?? "[]") as Array<{ publicId: string }>;
    assert(mcpStudies.some((study) => study.publicId === ownStudy));
    assert(!mcpStudies.some((study) => study.publicId === otherStudy));

    const mcpDenied = await callMcp(baseUrl, mcpKey.secret, "tools/call", {
      name: "create_study",
      arguments: { brief: `MCP ${suffix} 不应越过 studies:write 权限。`, productLine: "research" },
    });
    assert.equal(mcpDenied.result?.isError, true);
    assert.match(mcpDenied.result?.content?.[0]?.text ?? "", /studies:write/);

    assert.equal((await fetch(`${baseUrl}/api/v1/studies`, { headers: apiHeaders(revokedKey.secret) })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/v1/studies`, { headers: apiHeaders(expiredKey.secret) })).status, 401);
    await database.query(
      "delete from workspace_members where workspace_id = $1 and user_id = $2",
      [viewer.workspaceId, viewer.userId],
    );
    assert.equal((await fetch(`${baseUrl}/api/v1/studies`, { headers: apiHeaders(removedMemberKey.secret) })).status, 401);

    const audit = await database.query<{
      outcome: string; required_scope: string; response_status: number; count: number;
    }>(
      `select outcome, required_scope, response_status, count(*)::int as count
       from external_api_audit_events where workspace_id = $1
       group by outcome, required_scope, response_status
       order by outcome, required_scope, response_status`,
      [viewer.workspaceId],
    );
    assert(audit.rows.some((row) => row.outcome === "authorized" && row.required_scope === "studies:read" && row.response_status === 200));
    assert(audit.rows.some((row) => row.outcome === "authorized" && row.required_scope === "studies:write" && row.response_status === 201));
    assert(audit.rows.some((row) => row.outcome === "scope_denied" && row.response_status === 403));
    assert(audit.rows.some((row) => row.outcome === "revoked" && row.response_status === 401));
    assert(audit.rows.some((row) => row.outcome === "expired" && row.response_status === 401));
    assert(audit.rows.some((row) => row.outcome === "membership_revoked" && row.response_status === 401));

    console.log(JSON.stringify({
      secretStoredAsHashOnly: true,
      restScopeEnforced: true,
      workspaceIsolation: true,
      mcpToolScopeEnforced: true,
      revokedKeyRejected: true,
      expiredKeyRejected: true,
      removedMemberKeyRejected: true,
      auditOutcomes: audit.rows,
    }, null, 2));
  } finally {
    await stopNextServer();
    for (const workspaceId of workspaceIds) {
      await database.query("delete from workspaces where id = $1", [workspaceId]);
    }
    for (const authUserId of authUserIds) {
      await database.query("delete from auth.users where id = $1", [authUserId]);
    }
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
