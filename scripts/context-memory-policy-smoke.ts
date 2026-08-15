import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  createContextAsset,
  createContextBehaviorObservation,
  getContextMemoryDetail,
  listContextMemoryPolicies,
  promoteContextMemory,
  retrieveContext,
  reviewContextAsset,
  reviewContextBehaviorObservation,
  updateContextMemoryPolicy,
} from "../src/lib/context-system";

if (process.env.CONTEXT_MEMORY_POLICY_SMOKE_CONFIRM !== "1") {
  throw new Error("Set CONTEXT_MEMORY_POLICY_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Context memory policy smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserIds = [randomUUID(), randomUUID()];
const workspaceIds: string[] = [];

function requireAsset(result: Awaited<ReturnType<typeof createContextAsset>>) {
  assert.notEqual(result, "forbidden");
  assert.notEqual(result, "study_not_found");
  if (typeof result === "string") throw new Error(`CONTEXT_ASSET_CREATE_FAILED:${result}`);
  return result;
}

async function main() {
  const database = await getDatabase();
  try {
    const seeded = await database.transaction(async (transaction) => {
      for (const [index, authUserId] of authUserIds.entries()) {
        await transaction.query(
          `insert into auth.users (id, email, raw_user_meta_data)
           values ($1, $2, $3::jsonb)`,
          [authUserId, `memory-policy-${index}-${suffix}@example.com`, JSON.stringify({ display_name: `Memory policy smoke ${index}` })],
        );
      }
      const users = await transaction.query<{
        user_id: string; user_public_id: string; auth_user_id: string;
        workspace_id: string; workspace_public_id: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                app_user.auth_user_id::text as auth_user_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id
         from users app_user
         join workspace_members member on member.user_id = app_user.id and member.role = 'owner'
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = any($1::uuid[])
         order by app_user.email`,
        [authUserIds],
      );
      const primary = users.rows[0];
      const secondary = users.rows[1];
      workspaceIds.push(...users.rows.map((user) => user.workspace_id));
      await transaction.query(
        `insert into workspace_members (workspace_id, user_id, role)
         values ($1, $2, 'member')`,
        [primary.workspace_id, secondary.user_id],
      );
      return { primary, secondary };
    });
    const viewer = {
      userId: seeded.primary.user_id,
      userPublicId: seeded.primary.user_public_id,
      displayName: "Memory policy smoke owner",
      email: `memory-policy-0-${suffix}@example.com`,
      workspaceId: seeded.primary.workspace_id,
      workspacePublicId: seeded.primary.workspace_public_id,
      workspaceName: "Memory policy smoke",
      role: "owner" as const,
      tokenBalance: 0,
    };
    const secondViewer = {
      userId: seeded.secondary.user_id,
      userPublicId: seeded.secondary.user_public_id,
      displayName: "Memory policy smoke member",
      email: `memory-policy-1-${suffix}@example.com`,
      workspaceId: seeded.primary.workspace_id,
      workspacePublicId: seeded.primary.workspace_public_id,
      workspaceName: "Memory policy smoke",
      role: "member" as const,
      tokenBalance: 0,
    };

    const policies = await listContextMemoryPolicies(viewer);
    assert.deepEqual(policies.map((policy) => [policy.memoryKind, policy.version]), [["core", 1], ["working", 1], ["team", 1]]);

    const sourceOne = requireAsset(await createContextAsset(viewer, {
      assetType: "research_sample", scope: "workspace", studyPublicId: null,
      title: "通勤行为原始样本", description: "Memory 观察证据一", sourceUri: null,
      content: `原始样本 ${suffix}：下雨时选择直达公交。`, changeNote: "Smoke source",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "human", consentStatus: "confirmed", piiStatus: "redacted",
      retentionExpiresAt: null, reviewStatus: "approved",
    }));
    const sourceTwo = requireAsset(await createContextAsset(viewer, {
      assetType: "document", scope: "workspace", studyPublicId: null,
      title: "通勤决策补充记录", description: "Memory 观察证据二", sourceUri: null,
      content: `补充记录 ${suffix}：决策时更关注换乘次数。`, changeNote: "Smoke source",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "human", consentStatus: "confirmed", piiStatus: "redacted",
      retentionExpiresAt: null, reviewStatus: "approved",
    }));
    const core = requireAsset(await createContextAsset(viewer, {
      assetType: "core_memory", scope: "user", studyPublicId: null,
      title: "个人通勤偏好", description: "Purpose policy 验证", sourceUri: null,
      content: `核心记忆 ${suffix}：偏好少换乘的通勤路线。`, changeNote: "Smoke memory",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "human", consentStatus: "confirmed", piiStatus: "none",
      retentionExpiresAt: null, memoryConfidence: "high", reviewStatus: "approved",
    }));

    const intent = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId,
      query: `核心记忆 ${suffix}`, purpose: "intent_planning", audit: false,
    });
    assert(intent.citations.some((citation) => citation.assetPublicId === core.publicId && citation.memoryKind === "core"));
    assert(intent.policyDecision.allowedMemoryChunks > 0);
    const skillDenied = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId,
      query: `核心记忆 ${suffix}`, purpose: "skill_execution", audit: false,
    });
    assert(!skillDenied.citations.some((citation) => citation.assetPublicId === core.publicId));
    assert(skillDenied.policyDecision.denialReasons.purpose_not_allowed > 0);
    const crossUser = await retrieveContext({
      workspaceId: secondViewer.workspaceId, userId: secondViewer.userId,
      query: `核心记忆 ${suffix}`, purpose: "intent_planning", audit: false,
    });
    assert(!crossUser.citations.some((citation) => citation.assetPublicId === core.publicId));

    const expired = requireAsset(await createContextAsset(viewer, {
      assetType: "working_memory", scope: "user", studyPublicId: null,
      title: "已过期工作记忆", description: "Expiry gate", sourceUri: null,
      content: `已过期记忆 ${suffix}：不应被检索。`, changeNote: "Smoke expiry",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "human", consentStatus: "confirmed", piiStatus: "none",
      retentionExpiresAt: "2027-08-20T23:59:59.000Z", memoryConfidence: "low", reviewStatus: "approved",
    }));
    await database.query(
      `update context_assets set retention_expires_at = now() - interval '1 day' where public_id = $1`,
      [expired.publicId],
    );
    await database.query(
      `update context_memory_bindings binding set valid_from = now() - interval '2 days',
              valid_until = now() - interval '1 day'
       from context_assets asset where asset.id = binding.asset_id and asset.public_id = $1`,
      [expired.publicId],
    );
    const expiredSearch = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId,
      query: `已过期记忆 ${suffix}`, purpose: "research_execution", audit: false,
    });
    assert(!expiredSearch.citations.some((citation) => citation.assetPublicId === expired.publicId));

    const working = requireAsset(await createContextAsset(viewer, {
      assetType: "working_memory", scope: "user", studyPublicId: null,
      title: "雨天通勤工作记忆", description: "Promotion gate", sourceUri: null,
      content: `工作记忆 ${suffix}：正在验证雨天通勤偏好。`, changeNote: "Smoke working memory",
      ingestionMethod: "manual", sourceName: null, sourceMimeType: null,
      evidenceKind: "human", consentStatus: "confirmed", piiStatus: "none",
      retentionExpiresAt: null, memoryConfidence: "medium", reviewStatus: "approved",
    }));
    const observationInputs = [
      {
        sourceAssetPublicId: sourceOne.publicId, observationType: "preference" as const,
        statement: `雨天优先选择直达公交 ${suffix}`,
        evidenceKind: "human_observation" as const, confidence: "high" as const,
        observedAt: "2026-08-14T10:00:00.000+08:00", validUntil: null,
      },
      {
        sourceAssetPublicId: sourceTwo.publicId, observationType: "decision_signal" as const,
        statement: `换乘次数比理论最短时间更重要 ${suffix}`,
        evidenceKind: "human_observation" as const, confidence: "medium" as const,
        observedAt: "2026-08-14T11:00:00.000+08:00", validUntil: null,
      },
    ];
    const observations = [];
    for (const input of observationInputs) {
      const observation = await createContextBehaviorObservation(viewer, working.publicId, input);
      assert.equal(typeof observation, "object");
      if (typeof observation !== "object") throw new Error(`OBSERVATION_CREATE_FAILED:${observation}`);
      observations.push(observation);
    }
    const blockedBeforeReview = await promoteContextMemory(viewer, working.publicId, { targetMemoryKind: "core", note: "尝试提前晋升" });
    assert.equal(typeof blockedBeforeReview, "object");
    if (typeof blockedBeforeReview !== "object") throw new Error(`PROMOTION_FAILED:${blockedBeforeReview}`);
    assert.equal(blockedBeforeReview.status, "insufficient_observations");

    for (const observation of observations) {
      const approved = await reviewContextBehaviorObservation(viewer, working.publicId, {
        observationPublicId: observation.publicId, action: "approve", note: "证据范围已复核",
      });
      assert.equal(typeof approved, "object");
    }
    await reviewContextBehaviorObservation(viewer, working.publicId, {
      observationPublicId: observations[0].publicId, action: "approve", note: "重复审核不应写入新事件",
    });
    const promoted = await promoteContextMemory(viewer, working.publicId, { targetMemoryKind: "core", note: "两条已审核观察满足晋升门槛" });
    assert.equal(typeof promoted, "object");
    if (typeof promoted !== "object" || !("publicId" in promoted)) throw new Error("PROMOTION_CANDIDATE_MISSING");
    assert.equal(promoted.status, "pending");
    const repeatedPromotion = await promoteContextMemory(viewer, working.publicId, { targetMemoryKind: "core", note: "重复晋升" });
    assert.equal(typeof repeatedPromotion, "object");
    if (typeof repeatedPromotion !== "object") throw new Error("PROMOTION_IDEMPOTENCY_FAILED");
    assert.equal(repeatedPromotion.status, "existing_candidate");

    const beforeCandidateApproval = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId,
      query: `雨天优先选择直达公交 ${suffix}`, purpose: "general", audit: false,
    });
    assert(!beforeCandidateApproval.citations.some((citation) => citation.assetPublicId === promoted.publicId));
    const approvedCandidate = await reviewContextAsset(viewer, promoted.publicId, { action: "approve", note: "晋升证据已复核" });
    assert.equal(typeof approvedCandidate, "object");
    const afterCandidateApproval = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId,
      query: `雨天优先选择直达公交 ${suffix}`, purpose: "general", audit: false,
    });
    assert(afterCandidateApproval.citations.some((citation) => citation.assetPublicId === promoted.publicId));

    const corePolicy = policies.find((policy) => policy.memoryKind === "core");
    assert(corePolicy);
    const versioned = await updateContextMemoryPolicy(viewer, corePolicy.publicId, {
      allowedPurposes: ["intent_planning", "research_execution", "report_generation"],
      reviewRequired: true, defaultRetentionDays: null, decayDays: 365,
      promotionMinObservations: 2, conflictStrategy: "manual_review",
    });
    assert.equal(typeof versioned, "object");
    if (typeof versioned !== "object") throw new Error(`POLICY_VERSION_FAILED:${versioned}`);
    assert.equal(versioned.version, 2);
    const currentPolicies = await listContextMemoryPolicies(viewer);
    assert.equal(currentPolicies.find((policy) => policy.memoryKind === "core")?.version, 2);
    const deniedAfterPolicyUpdate = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId,
      query: `雨天优先选择直达公交 ${suffix}`, purpose: "general", audit: false,
    });
    assert(!deniedAfterPolicyUpdate.citations.some((citation) => citation.assetPublicId === promoted.publicId));
    assert(deniedAfterPolicyUpdate.policyDecision.denialReasons.purpose_not_allowed > 0);

    const audited = await retrieveContext({
      workspaceId: viewer.workspaceId, userId: viewer.userId,
      query: `雨天优先选择直达公交 ${suffix}`, purpose: "intent_planning",
    });
    assert(audited.retrievalPublicId);
    assert(audited.citations.some((citation) => citation.assetPublicId === promoted.publicId));
    const persisted = await database.query<{ purpose: string; policy_version: string; policy_decision: Record<string, unknown> | string }>(
      `select purpose, policy_version, policy_decision from context_retrievals where public_id = $1`,
      [audited.retrievalPublicId],
    );
    assert.equal(persisted.rows[0].purpose, "intent_planning");
    assert.equal(persisted.rows[0].policy_version, "memory-policy-v1");
    const persistedDecision = typeof persisted.rows[0].policy_decision === "string"
      ? JSON.parse(persisted.rows[0].policy_decision) as Record<string, unknown>
      : persisted.rows[0].policy_decision;
    assert.equal(persistedDecision.purpose, "intent_planning");

    const detail = await getContextMemoryDetail(viewer, working.publicId);
    assert.notEqual(detail, "not_found");
    if (detail === "not_found") throw new Error("MEMORY_DETAIL_MISSING");
    assert.equal(detail.observations.filter((observation) => observation.status === "approved").length, 2);
    assert.equal(detail.events.filter((event) => event.eventType === "observation.approved").length, 2);
    assert.equal(detail.events.filter((event) => event.eventType === "promotion.proposed").length, 1);

    console.log(JSON.stringify({
      defaultPolicyVersions: policies.map((policy) => `${policy.memoryKind}@${policy.version}`),
      purposePolicyBeforeRanking: true,
      crossUserIsolation: true,
      expiredMemoryExcluded: true,
      approvedObservationCount: 2,
      promotionRequiresEvidenceAndReview: true,
      promotionIdempotent: true,
      currentCorePolicyVersion: 2,
      retrievalPolicyDecisionPersisted: true,
      governanceEventsIdempotent: true,
    }, null, 2));
  } finally {
    if (workspaceIds.length) await database.query("delete from workspaces where id = any($1::bigint[])", [workspaceIds]);
    await database.query("delete from auth.users where id = any($1::uuid[])", [authUserIds]);
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
