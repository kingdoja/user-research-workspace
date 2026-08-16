import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  approveWorkspaceSkillPackage,
  executeWorkspaceSkill,
  exportWorkspaceSkillPackage,
  getRunSkillBinding,
  hashSkillPackage,
  importWorkspaceSkillPackage,
  lockRunWorkspaceSkill,
  probeWorkspaceSkill,
  revokeWorkspaceSkill,
  setWorkspaceSkillEnabled,
  skillPackageInputSchema,
} from "../src/lib/skill-gateway";
import { executeConfiguredSkill, SkillExecutionError } from "../src/lib/skill-executor";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.SKILL_PACKAGE_GOVERNANCE_SMOKE_CONFIRM !== "1") {
  throw new Error("Set SKILL_PACKAGE_GOVERNANCE_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Skill package governance smoke test only runs against a local database.");
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as { message?: string } : {};
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID()];
const workspaceIds: string[] = [];

async function main() {
  const secretName = "SKILL_SECRET_PACKAGE_GOVERNANCE";
  const oldSecret = process.env[secretName];
  process.env[secretName] = "package-secret-value";
  const server = createServer(async (request, response) => {
    if (request.url === "/http" && request.method === "OPTIONS") {
      response.writeHead(204, { allow: "POST, OPTIONS" }).end();
      return;
    }
    if (request.url === "/http" && request.method === "POST") {
      const body = await readBody(request);
      assert.equal(request.headers["x-skill-key"], "package-secret-value");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ echoed: body.message ?? "" }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/http`;
  const database = await getDatabase();
  try {
    const viewers = [];
    for (const [index, authUserId] of authUserIds.entries()) {
      await database.query(
        `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
        [authUserId, `skill-package-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `Package smoke ${index}` })],
      );
      const actor = await database.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string; workspace_name: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id, workspace.name as workspace_name
         from users app_user join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceIds.push(actor.rows[0].workspace_id);
      viewers.push({
        userId: actor.rows[0].user_id, userPublicId: actor.rows[0].user_public_id, displayName: `Package smoke ${index}`,
        email: `skill-package-${index}-${suffix}@example.com`, workspaceId: actor.rows[0].workspace_id,
        workspacePublicId: actor.rows[0].workspace_public_id, workspaceName: actor.rows[0].workspace_name,
        role: "owner" as const, tokenBalance: 0,
      });
    }
    const [viewer, otherViewer] = viewers;
    const unsafe = skillPackageInputSchema.safeParse({
      format: "atypica.skill/v1",
      manifest: { slug: `unsafe-${suffix}`, name: "Unsafe", executor: null },
      skillMarkdown: "# Unsafe",
      files: [{ name: "run.sh", content: "echo unsafe" }],
    });
    assert.equal(unsafe.success, false);

    const imported = await importWorkspaceSkillPackage(viewer, {
      format: "atypica.skill/v1",
      manifest: {
        slug: `package-echo-${suffix}`,
        name: "Governed Package Echo",
        description: "Governance smoke package",
        visibility: "workspace",
        capabilities: ["smoke.echo"],
        requestedCapabilities: ["network"],
        inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } }, additionalProperties: false },
        outputSchema: { type: "object", required: ["echoed"], properties: { echoed: { type: "string" } }, additionalProperties: false },
        executor: {
          kind: "declarative_http",
          endpoint,
          method: "POST",
          timeoutMs: 5_000,
          maxResponseBytes: 16_384,
          headersFromEnv: { "x-skill-key": secretName },
        },
        changeNote: "Package governance smoke",
      },
      skillMarkdown: "# Governed Package Echo\n\nA declarative Skill package used only by isolated smoke tests.\n",
      signature: { algorithm: "ed25519", keyId: "smoke-key", value: "declared-not-verified" },
    });
    assert.equal(typeof imported, "object");
    if (typeof imported !== "object") throw new Error(`Package import failed: ${imported}`);
    assert.equal(await exportWorkspaceSkillPackage(viewer, imported.publicId), "not_found");
    assert.equal(await executeWorkspaceSkill(viewer, imported.publicId, { message: "blocked" }), "not_found");
    assert.equal(
      await setWorkspaceSkillEnabled(viewer, { source: "workspace", slug: `package-echo-${suffix}`, publicId: imported.publicId, enabled: true }),
      "pending_approval",
    );
    const mismatch = await approveWorkspaceSkillPackage(viewer, imported.publicId, { grants: [] });
    assert.equal(typeof mismatch, "object");
    assert.equal(typeof mismatch === "object" && "error" in mismatch ? mismatch.error : null, "capability_mismatch");
    const approved = await approveWorkspaceSkillPackage(viewer, imported.publicId, { grants: [{ capability: "network", scope: { origins: [endpoint] } }] });
    assert.deepEqual(approved, { status: "active", grantedCapabilities: ["network"] });
    assert.deepEqual(
      await setWorkspaceSkillEnabled(viewer, { source: "workspace", slug: `package-echo-${suffix}`, publicId: imported.publicId, enabled: true }),
      { enabled: true, pinnedVersion: 1 },
    );
    const execution = await executeWorkspaceSkill(viewer, imported.publicId, { message: "governed" });
    assert.equal(typeof execution, "object");
    if (typeof execution !== "object" || !("output" in execution)) throw new Error("Package execution failed");
    assert.deepEqual(execution.output, { echoed: "governed" });
    await assert.rejects(
      executeConfiguredSkill({
        config: {
          kind: "declarative_http", endpoint, method: "POST", timeoutMs: 5_000,
          maxResponseBytes: 16_384, headersFromEnv: { "x-skill-key": secretName },
        },
        inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } }, additionalProperties: false },
        outputSchema: { type: "object", required: ["echoed"], properties: { echoed: { type: "string" } }, additionalProperties: false },
        arguments: { message: "scope denied" },
        policy: { allowedNetworkOrigins: [`http://localhost:${address.port}`] },
      }),
      (error: unknown) => error instanceof SkillExecutionError && error.code === "SKILL_EXECUTOR_NETWORK_SCOPE_DENIED",
    );
    const health = await probeWorkspaceSkill(viewer, imported.publicId);
    assert.equal(typeof health, "object");
    if (typeof health !== "object" || !("status" in health)) throw new Error("Health probe failed");
    assert.equal(health.status, "healthy");

    const exported = await exportWorkspaceSkillPackage(viewer, imported.publicId);
    assert.equal(typeof exported, "object");
    if (typeof exported !== "object") throw new Error("Approved package could not be exported");
    assert.equal(hashSkillPackage(exported), imported.packageHash);
    assert.equal(await exportWorkspaceSkillPackage(otherViewer, imported.publicId), "not_found");
    const storedExecutor = await database.query<{ executor_config: string }>(
      `select executor_config::text from skill_versions version join skill_manifests skill on skill.id = version.skill_id
       where skill.public_id = $1`,
      [imported.publicId],
    );
    assert.match(storedExecutor.rows[0].executor_config, new RegExp(secretName));
    assert.doesNotMatch(storedExecutor.rows[0].executor_config, /package-secret-value/);

    const study = await database.query<{ id: string }>(
      `insert into studies (
         public_id, workspace_id, created_by, title, brief, study_type, status, current_stage, estimated_tokens
       ) values ($1, $2, $3, 'Skill package binding smoke', '验证权限快照', 'user_research', 'awaiting_confirmation', 'confirmation', 1000)
       returning id::text as id`,
      [`std_package_${suffix}`, viewer.workspaceId, viewer.userId],
    );
    const planVersion = await createSmokePlanVersion(database, study.rows[0].id, viewer.userId);
    const run = await database.query<{ id: string }>(
      `insert into study_runs (study_id, plan_version_id, status) values ($1, $2, 'queued') returning id::text as id`,
      [study.rows[0].id, planVersion.id],
    );
    const binding = await lockRunWorkspaceSkill({
      queryable: database, workspaceId: viewer.workspaceId, studyId: study.rows[0].id, runId: run.rows[0].id, publicId: imported.publicId,
    });
    assert.equal(typeof binding, "object");
    if (typeof binding !== "object") throw new Error(`Run binding failed: ${binding}`);
    assert.deepEqual(binding.grants, [{ capability: "network", scope: { origins: [endpoint] } }]);
    const replayBinding = await getRunSkillBinding(run.rows[0].id, binding.slug);
    assert(replayBinding);
    assert.deepEqual(replayBinding.capabilityGrants, binding.grants);
    await assert.rejects(
      database.query("update study_run_skill_bindings set enabled_at_lock = false where id = $1", [replayBinding.id]),
      /RUN_SKILL_BINDING_IMMUTABLE/,
    );
    assert.deepEqual(await revokeWorkspaceSkill(viewer, imported.publicId), { status: "revoked" });
    assert.equal(await executeWorkspaceSkill(viewer, imported.publicId, { message: "revoked" }), "not_found");
    assert(await getRunSkillBinding(run.rows[0].id, binding.slug));
    const audit = await database.query<{ health: number; controls: number; grants: number }>(
      `select
         (select count(*)::int from skill_executor_health_checks where skill_id = (select id from skill_manifests where public_id = $1)) as health,
         (select count(*)::int from skill_control_events where skill_id = (select id from skill_manifests where public_id = $1)) as controls,
         (select count(*)::int from workspace_skill_capability_grants where skill_id = (select id from skill_manifests where public_id = $1)) as grants`,
      [imported.publicId],
    );
    assert.equal(audit.rows[0].health, 1);
    assert(audit.rows[0].controls >= 3);
    assert.equal(audit.rows[0].grants, 1);
    console.log(JSON.stringify({
      format: "atypica.skill/v1", unsafePayloadRejected: true, importedSubmitted: true, approved: true,
      signatureState: "declared_unverified", secretReferenceOnly: true, health: "healthy",
      immutableRunGrantSnapshot: true, revokedExecutionBlocked: true, crossWorkspaceHidden: true,
    }, null, 2));
  } finally {
    for (const workspaceId of workspaceIds) await database.query("delete from workspaces where id = $1", [workspaceId]);
    for (const authUserId of authUserIds) await database.query("delete from auth.users where id = $1", [authUserId]);
    if (oldSecret === undefined) delete process.env[secretName]; else process.env[secretName] = oldSecret;
    await closeDatabase();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
