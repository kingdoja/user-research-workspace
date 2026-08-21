import assert from "node:assert/strict";
import { buildSourceConnectorAudit, type CollectedSourceCandidate } from "../src/lib/source-connectors";

function candidate(input: {
  publicId: string;
  canonicalUrl: string;
  status: CollectedSourceCandidate["status"];
  score: number | null;
  rank: number | null;
}): CollectedSourceCandidate {
  return {
    publicId: input.publicId,
    provider: "bing",
    query: "dedup smoke",
    rank: input.rank,
    score: input.score,
    title: input.publicId,
    url: input.canonicalUrl,
    canonicalUrl: input.canonicalUrl,
    status: input.status,
    rejectionReason: input.status === "collected" ? null : "SMOKE_REJECTION",
    resolvedTitle: input.publicId,
    snapshot: null,
    observation: null,
    metadata: {},
  };
}

const audit = buildSourceConnectorAudit({
  provider: "bing",
  queries: ["dedup smoke"],
  startedAt: new Date().toISOString(),
  candidates: [
    candidate({ publicId: "src_rejected", canonicalUrl: "https://example.com/a", status: "rejected", score: 0.9, rank: 1 }),
    candidate({ publicId: "src_collected", canonicalUrl: "https://example.com/a", status: "collected", score: 0.5, rank: 2 }),
    candidate({ publicId: "src_lower_score", canonicalUrl: "https://example.com/b", status: "collected", score: 0.5, rank: 1 }),
    candidate({ publicId: "src_higher_score", canonicalUrl: "https://example.com/b", status: "collected", score: 0.8, rank: 3 }),
    candidate({ publicId: "src_unique", canonicalUrl: "https://example.com/c", status: "unavailable", score: null, rank: null }),
  ],
});

assert.equal(audit.candidateCount, 3);
assert.equal(audit.collectedCount, 2);
assert.equal(audit.unavailableCount, 1);
assert.equal(audit.metadata.duplicateCandidateCount, 2);
assert.deepEqual(audit.candidates.map((item) => item.publicId), ["src_collected", "src_higher_score", "src_unique"]);
console.log(JSON.stringify({ candidateCount: audit.candidateCount, duplicateCandidateCount: audit.metadata.duplicateCandidateCount }));
