import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { getProviderStageStatus, withProviderRoute } from "../src/lib/openai-provider";
import {
  activateRoutingPolicyVersion,
  createCollaborationDelegation,
  createCollaborationPublication,
  createRoutingPolicyVersion,
  finishProviderRouteDecision,
  listCollaboration,
  listRoutingControl,
  resolveProviderRoute,
  updateCollaborationDelegationStatus,
  updateCollaborationPublicationStatus,
} from "../src/lib/platform-control";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.PLATFORM_CONTROL_SMOKE_CONFIRM !== "1") {
  throw new Error("Set PLATFORM_CONTROL_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Platform control smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID(), randomUUID()];
const workspaceIds: string[] = [];

async function main() {
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  process.env.OPENAI_API_KEY = "smoke-openai-key";
  process.env.DEEPSEEK_API_KEY = "smoke-deepseek-key";
  const database = await getDatabase();
  try {
    const viewers = [];
    for (const [index, authUserId] of authUserIds.entries()) {
      await database.query(
        "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)",
        [authUserId, `platform-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `Platform smoke ${index}` })],
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
        displayName: `Platform smoke ${index}`, email: `platform-${index}-${suffix}@example.com`,
        workspaceId: actor.rows[0].workspace_id, workspacePublicId: actor.rows[0].workspace_public_id,
        workspaceName: actor.rows[0].workspace_name, role: "owner" as const, tokenBalance: 0,
      });
    }
    const [publisher, recipient, outsider] = viewers;
    const studyPublicId = `std_platform_${suffix}`;
    const reportPublicId = `rpt_platform_${suffix}`;
    const study = await database.query<{ id: string }>(
      `insert into studies (
         public_id, workspace_id, created_by, title, brief, study_type, status, current_stage, estimated_tokens
       ) values ($1, $2, $3, 'Platform control smoke', 'Cross-workspace immutable report package',
                 'user_research', 'completed', 'report', 1000) returning id::text as id`,
      [studyPublicId, publisher.workspaceId, publisher.userId],
    );
    const planVersion = await createSmokePlanVersion(database, study.rows[0].id, publisher.userId);
    await database.query(
      `insert into reports (public_id, study_id, title, description, content_html, content_json)
       values ($1, $2, 'Platform smoke report', 'Immutable collaboration payload', '<p>smoke</p>', $3::jsonb)`,
      [reportPublicId, study.rows[0].id, JSON.stringify({ finding: "snapshot cannot drift" })],
    );

    const draft = await createCollaborationPublication(publisher, {
      recipientWorkspacePublicId: recipient.workspacePublicId,
      artifactType: "report", artifactPublicId: reportPublicId,
      capabilities: ["view", "import", "delegate"],
    });
    assert.equal(typeof draft, "object");
    if (typeof draft !== "object") throw new Error(`Publication failed: ${draft}`);
    assert.equal((await listCollaboration(recipient)).publications.length, 0);
    assert.equal((await listCollaboration(outsider)).publications.length, 0);
    assert.deepEqual(await updateCollaborationPublicationStatus(publisher, draft.publicId, "submitted"), { status: "submitted" });
    assert.equal((await listCollaboration(recipient)).publications.length, 1);
    assert.deepEqual(await updateCollaborationPublicationStatus(recipient, draft.publicId, "accepted"), { status: "accepted" });
    const accepted = (await listCollaboration(recipient)).publications[0];
    assert.equal(accepted.governanceStatus, "pending_review");
    await assert.rejects(
      database.query("update collaboration_publications set artifact_hash = repeat('0', 64) where public_id = $1", [draft.publicId]),
      /COLLABORATION_PUBLICATION_SNAPSHOT_IMMUTABLE/,
    );
    const delegation = await createCollaborationDelegation(publisher, {
      recipientWorkspacePublicId: recipient.workspacePublicId,
      publicationPublicId: draft.publicId,
      title: "Review imported report", instructions: "Validate before local activation.",
    });
    assert.equal(typeof delegation, "object");
    if (typeof delegation !== "object") throw new Error(`Delegation failed: ${delegation}`);
    assert.deepEqual(await updateCollaborationDelegationStatus(recipient, delegation.publicId, "accepted"), { status: "accepted" });
    assert.deepEqual(await updateCollaborationDelegationStatus(recipient, delegation.publicId, "in_progress"), { status: "in_progress" });
    assert.deepEqual(await updateCollaborationDelegationStatus(recipient, delegation.publicId, "completed"), { status: "completed" });
    assert.deepEqual(await updateCollaborationPublicationStatus(publisher, draft.publicId, "revoked"), { status: "revoked" });
    assert.equal((await listCollaboration(recipient)).publications[0].governanceStatus, "archived");

    const policy = await createRoutingPolicyVersion(publisher, {
      policyKey: `research-${suffix}`, name: "Research quality route", stage: "research", description: "smoke",
      selectionMode: "weighted", maxEstimatedCostMicros: 100_000, maxLatencyMs: 60_000,
      minimumQualityTier: "standard", estimatedInputTokens: 1000, estimatedOutputTokens: 500,
      changeNote: "smoke", routes: [
        {
          routeKey: "openai", providerName: "openai", model: "gpt-smoke", protocol: "responses",
          priority: 1, weight: 1, qualityTier: "high", expectedLatencyMs: 1000,
          inputPriceMicrosPerMillion: 1000, outputPriceMicrosPerMillion: 2000,
          pricingSource: "smoke-price-v1", pricingEffectiveAt: "2026-08-17",
        },
        {
          routeKey: "deepseek", providerName: "deepseek", model: "deepseek-smoke", protocol: "chat_completions",
          priority: 2, weight: 1, qualityTier: "standard", expectedLatencyMs: 1200,
          inputPriceMicrosPerMillion: 500, outputPriceMicrosPerMillion: 800,
          pricingSource: "smoke-price-v1", pricingEffectiveAt: "2026-08-17",
        },
      ],
    });
    assert.equal(typeof policy, "object");
    if (typeof policy !== "object") throw new Error(`Policy failed: ${policy}`);
    assert.deepEqual(await activateRoutingPolicyVersion(publisher, policy.versionPublicId), { status: "active" });
    const run = await database.query<{ id: string }>(
      `insert into study_runs (study_id, plan_version_id, status) values ($1, $2, 'running') returning id::text as id`,
      [study.rows[0].id, planVersion.id],
    );
    const route = await database.transaction((transaction) => resolveProviderRoute({
      queryable: transaction, workspaceId: publisher.workspaceId, runId: run.rows[0].id,
      taskId: null, stage: "research", subjectKey: `smoke:${suffix}`,
    }));
    assert(route);
    const routedStatus = await withProviderRoute(route.override, async () => getProviderStageStatus("research"));
    assert.equal(routedStatus.providerName, route.override.providerName);
    assert.equal(routedStatus.model, route.override.model);
    await finishProviderRouteDecision({
      queryable: database, decisionId: route.decisionId,
      usage: { input_tokens: 1000, output_tokens: 500 }, latencyMs: 321, qualityScore: 91,
    });
    const control = await listRoutingControl(publisher);
    assert.equal(control.policies[0].versions[0].status, "active");
    assert.equal(control.decisions[0].status, "completed");
    assert.equal(control.decisions[0].latencyMs, 321);
    await assert.rejects(
      database.query("update study_run_routing_bindings set stage = 'report' where run_id = $1", [run.rows[0].id]),
      /RUN_ROUTING_BINDING_IMMUTABLE/,
    );
    await assert.rejects(
      database.query("update provider_route_decisions set latency_ms = 999 where id = $1", [route.decisionId]),
      /PROVIDER_ROUTE_DECISION_RESULT_IMMUTABLE/,
    );
    console.log(JSON.stringify({
      draftHiddenFromRecipient: true, outsiderHidden: true, immutablePublicationSnapshot: true,
      governedImportPending: true, delegationLifecycle: "completed", versionedRoutingBinding: true,
      deterministicDecisionLedger: true, actualCostRecorded: control.decisions[0].actualCostMicros,
    }, null, 2));
  } finally {
    for (const workspaceId of workspaceIds) await database.query("delete from workspaces where id = $1", [workspaceId]);
    for (const authUserId of authUserIds) await database.query("delete from auth.users where id = $1", [authUserId]);
    if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAIKey;
    if (oldDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldDeepSeekKey;
    await closeDatabase();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
