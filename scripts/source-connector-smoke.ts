import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { buildReportEvidenceCatalog } from "../src/lib/report-evidence";
import {
  buildSourceConnectorAudit,
  collectSourceCandidate,
  markSourceCandidateUnavailable,
  materializeSourceConnectorAudit,
  summarizeSourceConnectorAudit,
  type SourceCandidate,
} from "../src/lib/source-connectors";

if (process.env.SOURCE_CONNECTOR_SMOKE_CONFIRM !== "1") {
  throw new Error("Set SOURCE_CONNECTOR_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Source connector smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

const sharedPage = `<!doctype html><html><head><title>Auditable source</title></head><body><main>${"Public research evidence with stable content and a verifiable source boundary. ".repeat(8)}</main></body></html>`;
const accessPage = `<!doctype html><html><head><title>Sign in to continue</title></head><body><main>${"Sign in to continue and verify you are human before viewing this protected content. ".repeat(8)}</main></body></html>`;

const mockFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (url.pathname === "/robots.txt") {
    if (url.hostname === "deny.example") return new Response("User-agent: *\nDisallow: /private", { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("User-agent: *\nAllow: /", { status: 200, headers: { "content-type": "text/plain" } });
  }
  if (url.hostname === "deny.example") return new Response(sharedPage, { status: 200, headers: { "content-type": "text/html" } });
  if (url.hostname === "type.example") return new Response("png", { status: 200, headers: { "content-type": "image/png" } });
  if (url.hostname === "large.example") return new Response(null, { status: 200, headers: { "content-type": "text/html", "content-length": "1500001" } });
  if (url.hostname === "redirect.example") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  if (url.hostname === "unavailable.example") return new Response("temporarily unavailable", { status: 503, headers: { "content-type": "text/plain" } });
  if (url.hostname === "access.example") return new Response(accessPage, { status: 200, headers: { "content-type": "text/html" } });
  return new Response(sharedPage, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", etag: `"${suffix}"`, "last-modified": "Thu, 14 Aug 2026 00:00:00 GMT" },
  });
};

const lookupHost = async () => [{ address: "93.184.216.34" }];

function source(name: string, path = "/public"): SourceCandidate {
  return {
    publicId: `src_${name}_${suffix}`,
    provider: "bing",
    query: "source connector smoke",
    rank: 1,
    score: null,
    title: `${name} source`,
    url: `https://${name}.example${path}`,
    providerExcerpt: "Search-result metadata must not become evidence without a collected snapshot.",
  };
}

async function main() {
  const database = await getDatabase();
  try {
    const candidates = [
      source("allow"),
      source("duplicate"),
      source("deny", "/private/article"),
      source("type"),
      source("large"),
      source("redirect"),
      source("unavailable"),
      source("access"),
    ];
    const collected = await Promise.all(candidates.map((candidate) => collectSourceCandidate(candidate, { fetchImpl: mockFetch, lookupHost })));
    assert.deepEqual(collected.map((item) => item.status), [
      "collected", "collected", "rejected", "rejected", "rejected", "rejected", "unavailable", "rejected",
    ]);
    assert.equal(collected[2].rejectionReason, "SOURCE_ROBOTS_DENIED");
    assert.equal(collected[3].rejectionReason, "SOURCE_NOT_TEXT");
    assert.equal(collected[4].rejectionReason, "SOURCE_TOO_LARGE");
    assert.equal(collected[5].rejectionReason, "SOURCE_UNSAFE_URL");
    assert.equal(collected[7].rejectionReason, "SOURCE_ACCESS_RESTRICTED");
    assert.equal(collected[0].snapshot?.contentHash, collected[1].snapshot?.contentHash, "identical content must share a hash");

    const seeded = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Source Connector Smoke"}'::jsonb)`,
        [authUserId, `source-connector-${suffix}@example.com`],
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
         values ($1, $2, $3, 'Source connector smoke', 'Verify public source audit', 'running', 'execution') returning id::text as id`,
        [`std_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const run = await transaction.query<{ id: string }>(
        `insert into study_runs (study_id, status, provider, provider_model, started_at)
         values ($1, 'running', 'smoke', 'smoke-model', now()) returning id::text as id`,
        [study.rows[0].id],
      );
      return { studyId: study.rows[0].id, runId: run.rows[0].id };
    });

    const audit = buildSourceConnectorAudit({
      publicId: `scr_${suffix}`,
      provider: "bing",
      queries: ["source connector smoke"],
      startedAt: new Date().toISOString(),
      candidates: collected,
    });
    assert.equal(audit.status, "partial");
    assert.equal(audit.collectedCount, 2);
    assert.equal(audit.rejectedCount, 5);
    assert.equal(audit.unavailableCount, 1);
    const auditSummary = summarizeSourceConnectorAudit(audit);
    assert.equal("rawContent" in auditSummary.candidates[0].snapshot!, false);
    assert.equal("content" in auditSummary.candidates[0].observation!, false);
    assert.equal("providerExcerpt" in auditSummary.candidates[0], false);
    await database.transaction((transaction) => materializeSourceConnectorAudit(transaction, {
      workspaceId: workspaceId!, studyId: seeded.studyId, runId: seeded.runId,
      taskKey: "research", attempt: 1, audit,
    }));

    const removedSnapshot = await markSourceCandidateUnavailable(database, collected[0].publicId, "removed", "SOURCE_REMOVED_UPSTREAM");
    assert(removedSnapshot);
    const evidenceCatalog = buildReportEvidenceCatalog({
      sources: [{
        title: collected[1].resolvedTitle,
        url: collected[1].canonicalUrl,
        excerpt: collected[1].observation!.content,
        connectorRunPublicId: audit.publicId,
        candidatePublicId: collected[1].publicId,
        snapshotPublicId: collected[1].snapshot!.publicId,
        observationPublicId: collected[1].observation!.publicId,
        contentHash: collected[1].snapshot!.contentHash!,
        collectedAt: collected[1].snapshot!.fetchedAt,
      }],
    });
    assert.equal(evidenceCatalog[0].metadata.snapshotPublicId, collected[1].snapshot!.publicId);
    assert.equal(evidenceCatalog[0].locator.observationPublicId, collected[1].observation!.publicId);

    await assert.rejects(
      database.query("update source_snapshots set metadata = '{}'::jsonb where public_id = $1", [collected[1].snapshot!.publicId]),
      /source snapshots are immutable/,
    );
    const counts = await database.query<{
      runs: number; candidates: number; snapshots: number; observations: number; removed: number; unavailable: number;
    }>(
      `select
         (select count(*)::int from source_connector_runs where run_id = $1) runs,
         (select count(*)::int from source_candidates candidate join source_connector_runs connector_run on connector_run.id = candidate.connector_run_id where connector_run.run_id = $1) candidates,
         (select count(*)::int from source_snapshots snapshot join source_candidates candidate on candidate.id = snapshot.candidate_id join source_connector_runs connector_run on connector_run.id = candidate.connector_run_id where connector_run.run_id = $1) snapshots,
         (select count(*)::int from source_observations observation join source_candidates candidate on candidate.id = observation.candidate_id join source_connector_runs connector_run on connector_run.id = candidate.connector_run_id where connector_run.run_id = $1) observations,
         (select count(*)::int from source_candidates candidate join source_connector_runs connector_run on connector_run.id = candidate.connector_run_id where connector_run.run_id = $1 and candidate.status = 'removed') removed,
         (select count(*)::int from source_candidates candidate join source_connector_runs connector_run on connector_run.id = candidate.connector_run_id where connector_run.run_id = $1 and candidate.status = 'unavailable') unavailable`,
      [seeded.runId],
    );
    assert.deepEqual(counts.rows[0], { runs: 1, candidates: 8, snapshots: 4, observations: 2, removed: 1, unavailable: 1 });
    console.log(JSON.stringify({
      ...counts.rows[0], duplicateHash: true, robotsDenied: true, privateRedirectRejected: true,
      immutableSnapshot: true, evidenceSnapshotLinked: true, artifactAuditRedacted: true,
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
