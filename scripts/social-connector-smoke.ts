import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BLUESKY_CONNECTOR_POLICY_VERSION,
  collectBlueskyPublicPost,
  searchBlueskyPublicPosts,
} from "../src/lib/bluesky-social-connector";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  buildSourceConnectorAudit,
  materializeSourceConnectorAudit,
  summarizeSourceConnectorAudit,
} from "../src/lib/source-connectors";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.SOCIAL_CONNECTOR_SMOKE_CONFIRM !== "1") {
  throw new Error("Set SOCIAL_CONNECTOR_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Social connector smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;
const post = {
  uri: `at://did:plc:${suffix}/app.bsky.feed.post/${suffix}`,
  cid: `bafyreig${suffix}`,
  author: { did: `did:plc:${suffix}`, handle: `research-${suffix}.bsky.social`, displayName: "Public Researcher" },
  record: {
    $type: "app.bsky.feed.post",
    text: "A public social observation collected through the official Bluesky AppView API.",
    createdAt: "2026-08-17T01:02:03.000Z",
    langs: ["en"],
  },
  indexedAt: "2026-08-17T01:02:04.000Z",
  replyCount: 1,
  repostCount: 2,
  likeCount: 3,
  quoteCount: 0,
};
const requestedPaths: string[] = [];
const mockFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  requestedPaths.push(`${url.pathname}?${url.searchParams.toString()}`);
  if (url.pathname.endsWith("searchPosts")) return Response.json({ posts: [post] });
  if (url.pathname.endsWith("getPosts")) return Response.json({ posts: [post] });
  return Response.json({ error: "NotFound" }, { status: 404 });
};

async function main() {
  const database = await getDatabase();
  try {
    const discovered = await searchBlueskyPublicPosts("official api research", {
      fetchImpl: mockFetch,
      apiUrl: "http://127.0.0.1:4317",
    });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].provider, "bluesky");
    assert.equal("snapshot" in discovered[0], false, "search metadata must remain a candidate, not evidence");
    assert(discovered[0].providerExcerpt);

    const collected = await collectBlueskyPublicPost(discovered[0], {
      fetchImpl: mockFetch,
      apiUrl: "http://127.0.0.1:4317",
    });
    assert.equal(collected.status, "collected");
    assert.equal(collected.observation?.kind, "social_post");
    assert.equal(collected.snapshot?.metadata.officialApi, "app.bsky.feed.getPosts");
    assert.equal(collected.snapshot?.metadata.authorDid, post.author.did);
    assert.equal(collected.observation?.locator.upstreamUri, post.uri);
    assert(requestedPaths.some((path) => path.includes("searchPosts")));
    assert(requestedPaths.some((path) => path.includes("getPosts")));

    const seeded = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Social Connector Smoke"}'::jsonb)`,
        [authUserId, `social-connector-${suffix}@example.com`],
      );
      const actor = await transaction.query<{ user_id: string; workspace_id: string }>(
        `select app_user.id::text as user_id, workspace.id::text as workspace_id
         from users app_user join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceId = actor.rows[0].workspace_id;
      const study = await transaction.query<{ id: string }>(
        `insert into studies (public_id, workspace_id, created_by, title, brief, status, current_stage)
         values ($1, $2, $3, 'Social connector smoke', 'Verify official public API provenance', 'running', 'execution') returning id::text as id`,
        [`std_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const planVersion = await createSmokePlanVersion(transaction, study.rows[0].id, actor.rows[0].user_id);
      const run = await transaction.query<{ id: string }>(
        `insert into study_runs (study_id, plan_version_id, status, provider, provider_model, started_at)
         values ($1, $2, 'running', 'smoke', 'smoke-model', now()) returning id::text as id`,
        [study.rows[0].id, planVersion.id],
      );
      return { studyId: study.rows[0].id, runId: run.rows[0].id };
    });

    const audit = buildSourceConnectorAudit({
      publicId: `scr_${suffix}`,
      connectorKey: "bluesky-public",
      provider: "bluesky",
      policyVersion: BLUESKY_CONNECTOR_POLICY_VERSION,
      queries: ["official api research"],
      startedAt: new Date().toISOString(),
      candidates: [collected],
      metadata: { officialApi: true },
    });
    await database.transaction((transaction) => materializeSourceConnectorAudit(transaction, {
      workspaceId: workspaceId!,
      studyId: seeded.studyId,
      runId: seeded.runId,
      taskKey: "research",
      attempt: 1,
      audit,
    }));
    const summary = summarizeSourceConnectorAudit(audit);
    assert.equal(summary.connectorKey, "bluesky-public");
    assert.equal(summary.policyVersion, "bluesky-public-api-policy-v1");
    assert.equal("rawContent" in summary.candidates[0].snapshot!, false);
    assert.equal("content" in summary.candidates[0].observation!, false);

    const counts = await database.query<{ runs: number; snapshots: number; observations: number; social: number }>(
      `select
        (select count(*)::int from source_connector_runs where run_id = $1) runs,
        (select count(*)::int from source_snapshots snapshot join source_candidates candidate on candidate.id = snapshot.candidate_id join source_connector_runs connector_run on connector_run.id = candidate.connector_run_id where connector_run.run_id = $1) snapshots,
        (select count(*)::int from source_observations observation join source_candidates candidate on candidate.id = observation.candidate_id join source_connector_runs connector_run on connector_run.id = candidate.connector_run_id where connector_run.run_id = $1) observations,
        (select count(*)::int from source_connector_runs where run_id = $1 and connector_key = 'bluesky-public' and provider = 'bluesky') social`,
      [seeded.runId],
    );
    assert.deepEqual(counts.rows[0], { runs: 1, snapshots: 1, observations: 1, social: 1 });
    console.log(JSON.stringify({
      ...counts.rows[0], officialPublicApi: true, discoveryEvidenceBoundary: true,
      immutableSocialSnapshot: true, publicAuthorProvenance: true,
    }, null, 2));
  } finally {
    if (workspaceId) await database.query("delete from workspaces where id = $1", [workspaceId]);
    await database.query("delete from auth.users where id = $1", [authUserId]);
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
