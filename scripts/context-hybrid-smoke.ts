import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  createContextAsset,
  createContextEvaluationSet,
  listContextEvaluationSets,
  reindexContextAsset,
  retrieveContext,
  runContextEvaluation,
  tombstoneContextAsset,
} from "../src/lib/context-system";

if (process.env.CONTEXT_HYBRID_SMOKE_CONFIRM !== "1") {
  throw new Error("Set CONTEXT_HYBRID_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Context hybrid smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

async function startEmbeddingMock() {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: string[]; model?: string };
      const input = Array.isArray(payload.input) ? payload.input : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        model: payload.model,
        usage: { prompt_tokens: input.length, total_tokens: input.length },
        data: input.map((text, index) => ({
          object: "embedding",
          index,
          embedding: text.includes("公交") || text.includes("下雨")
            ? [1, 0, 0, 0, 0, 0, 0, 0]
            : [0, 1, 0, 0, 0, 0, 0, 0],
        })),
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("EMBEDDING_MOCK_ADDRESS_MISSING");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function main() {
  const database = await getDatabase();
  const embeddingMock = await startEmbeddingMock();
  try {
    const actor = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Context hybrid smoke"}'::jsonb)`,
        [authUserId, `context-hybrid-${suffix}@example.com`],
      );
      const result = await transaction.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id
         from users app_user
         join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      return result.rows[0];
    });
    workspaceId = actor.workspace_id;
    const viewer = {
      userId: actor.user_id,
      userPublicId: actor.user_public_id,
      displayName: "Context hybrid smoke",
      email: `context-hybrid-${suffix}@example.com`,
      workspaceId: actor.workspace_id,
      workspacePublicId: actor.workspace_public_id,
      workspaceName: "Context hybrid smoke",
      role: "owner" as const,
      tokenBalance: 0,
    };
    const relevant = await createContextAsset(viewer, {
      assetType: "research_sample",
      scope: "workspace",
      studyPublicId: null,
      title: "雨天公交通勤样本",
      description: "用于混合检索烟测",
      sourceUri: null,
      content: "雨天通勤时，受访者优先选择公交车，因为换乘少并且到达时间更稳定。",
      changeNote: "smoke",
    });
    assert.notEqual(relevant, "forbidden");
    assert.notEqual(relevant, "study_not_found");
    const relevantAsset = relevant as { publicId: string };
    await createContextAsset(viewer, {
      assetType: "document",
      scope: "workspace",
      studyPublicId: null,
      title: "办公咖啡采购",
      description: "干扰样本",
      sourceUri: null,
      content: "团队每周采购浅烘焙咖啡豆，并根据库存调整订单。",
      changeNote: "smoke",
    });
    const chunk = await database.query<{ public_id: string }>(
      `select chunk.public_id from context_chunks chunk
       join context_asset_versions version on version.id = chunk.asset_version_id
       join context_assets asset on asset.id = version.asset_id
       where asset.public_id = $1 and version.version = asset.current_version limit 1`,
      [relevantAsset.publicId],
    );
    const snapshot = await retrieveContext({
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: "下雨时怎样选择公交通勤",
      limit: 2,
    });
    assert.equal(snapshot.strategy, "hybrid_v1");
    assert.equal(snapshot.citations[0]?.chunkPublicId, chunk.rows[0].public_id);
    assert(snapshot.citations[0]?.reasons.includes("semantic_ngram"));

    const reindex = await reindexContextAsset(viewer, relevantAsset.publicId);
    assert.equal(typeof reindex, "object");
    if (typeof reindex !== "object") throw new Error("REINDEX_FAILED");
    assert.equal(reindex.generation, 2);
    assert.equal(reindex.chunkCount, 1);

    const evaluationSet = await createContextEvaluationSet(viewer, {
      name: "通勤检索评估",
      description: "smoke",
      cases: [{
        query: "下雨时怎样选择公交通勤",
        assetTypes: [],
        scopes: ["workspace"],
        topK: 2,
        expectedChunkPublicIds: [chunk.rows[0].public_id],
      }],
    });
    assert.equal(typeof evaluationSet, "object");
    if (typeof evaluationSet !== "object") throw new Error("EVALUATION_SET_FAILED");
    const evaluation = await runContextEvaluation(viewer, evaluationSet.publicId, { provider: "baseline" });
    assert.equal(typeof evaluation, "object");
    if (typeof evaluation !== "object") throw new Error("EVALUATION_RUN_FAILED");
    assert.equal(evaluation.metrics.recallAtK, 1);
    assert.equal(evaluation.metrics.meanReciprocalRank, 1);
    assert.equal(evaluation.baselineMetrics.recallAtK, 1);
    assert.equal(evaluation.gate.eligibleForIndexTrial, false);
    process.env.OPENAI_EMBEDDING_API_KEY = "context-smoke-key";
    process.env.OPENAI_EMBEDDING_BASE_URL = embeddingMock.baseUrl;
    process.env.OPENAI_EMBEDDING_PROVIDER_NAME = "local-smoke";
    process.env.OPENAI_EMBEDDING_VERSION = "mock-v1";
    const candidateEvaluation = await runContextEvaluation(viewer, evaluationSet.publicId, {
      provider: "openai",
      model: "mock-embedding-model",
    });
    assert.equal(typeof candidateEvaluation, "object");
    if (typeof candidateEvaluation !== "object") throw new Error("CANDIDATE_EVALUATION_RUN_FAILED");
    assert.equal(candidateEvaluation.target.provider, "openai");
    assert.equal(candidateEvaluation.target.providerName, "local-smoke");
    assert.equal(candidateEvaluation.target.model, "mock-embedding-model");
    assert.equal(candidateEvaluation.target.version, "mock-v1");
    assert.equal(candidateEvaluation.metrics.recallAtK, 1);
    assert.equal(candidateEvaluation.providerTelemetry.requestCount, 1);
    assert.equal(candidateEvaluation.providerTelemetry.dimensions, 8);
    const listedEvaluationSets = await listContextEvaluationSets(viewer);
    assert.equal(listedEvaluationSets[0]?.publicId, evaluationSet.publicId);
    assert.equal(listedEvaluationSets[0]?.runs.length, 2);
    assert.equal(listedEvaluationSets[0]?.runs[0]?.embeddingModel, "mock-embedding-model");

    const tombstone = await tombstoneContextAsset(viewer, relevantAsset.publicId, "烟测完成后下架样本");
    assert.equal(typeof tombstone, "object");
    const afterTombstone = await retrieveContext({
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: "下雨时怎样选择公交通勤",
      limit: 5,
      audit: false,
    });
    assert(!afterTombstone.citations.some((item) => item.assetPublicId === relevantAsset.publicId));
    const audit = await database.query<{ retrievals: number; items: number; runs: number }>(
      `select (select count(*)::int from context_retrievals where workspace_id = $1) as retrievals,
              (select count(*)::int from context_retrieval_items item
                join context_retrievals retrieval on retrieval.id = item.retrieval_id
                where retrieval.workspace_id = $1) as items,
              (select count(*)::int from context_reindex_runs where workspace_id = $1) as runs`,
      [viewer.workspaceId],
    );
    assert.equal(audit.rows[0].retrievals, 1);
    assert(audit.rows[0].items >= 1);
    assert.equal(audit.rows[0].runs, 1);
    console.log(JSON.stringify({
      strategy: snapshot.strategy,
      topChunk: snapshot.citations[0].chunkPublicId,
      reindex,
      evaluation: evaluation.metrics,
      candidateEvaluation: {
        target: candidateEvaluation.target,
        metrics: candidateEvaluation.metrics,
        deltas: candidateEvaluation.deltas,
        providerTelemetry: candidateEvaluation.providerTelemetry,
        gate: candidateEvaluation.gate,
      },
      tombstoneExcluded: true,
      historicalSnapshotItems: audit.rows[0].items,
    }, null, 2));
  } finally {
    if (workspaceId) await database.query("delete from workspaces where id = $1", [workspaceId]);
    await database.query("delete from auth.users where id = $1", [authUserId]);
    await new Promise<void>((resolve, reject) => embeddingMock.server.close((error) => error ? reject(error) : resolve()));
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
