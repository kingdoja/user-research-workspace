import { createHash } from "node:crypto";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export type ContextScope = "user" | "workspace" | "study" | "system";

export type ContextCitation = {
  chunkPublicId: string;
  assetPublicId: string;
  assetVersionPublicId: string;
  assetType: string;
  scope: ContextScope;
  title: string;
  sourceUri: string | null;
  version: number;
  content: string;
  score: number;
  reasons: string[];
};

export type ContextSnapshot = {
  retrievalId: string | null;
  retrievalPublicId: string | null;
  strategy: "lexical_metadata_v1" | "hybrid_v1";
  query: string;
  citations: ContextCitation[];
};

export const CONTEXT_EMBEDDING_BASELINE = {
  model: "hash-ngram-128",
  version: "v1",
  dimensions: 128,
} as const;

export const contextAssetInputSchema = z.object({
  assetType: z.enum(["core_memory", "working_memory", "document", "research_sample", "persona", "study_context"]),
  scope: z.enum(["user", "workspace", "study"]).default("workspace"),
  studyPublicId: z.string().trim().min(8).max(120).nullable().default(null),
  title: z.string().trim().min(2).max(180),
  description: z.string().trim().max(1000).default(""),
  sourceUri: z.string().trim().url().max(2000).nullable().default(null),
  content: z.string().trim().min(1).max(200_000),
  changeNote: z.string().trim().max(500).default("Initial version"),
}).superRefine((input, context) => {
  if (input.scope === "study" && !input.studyPublicId) {
    context.addIssue({ code: "custom", path: ["studyPublicId"], message: "研究级 Context 必须绑定 study" });
  }
  if (input.scope !== "study" && input.studyPublicId) {
    context.addIssue({ code: "custom", path: ["studyPublicId"], message: "只有研究级 Context 可以绑定 study" });
  }
});

export const contextVersionInputSchema = z.object({
  content: z.string().trim().min(1).max(200_000),
  changeNote: z.string().trim().min(1).max(500),
});

export const contextSearchInputSchema = z.object({
  query: z.string().trim().min(2).max(1000),
  assetTypes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  scopes: z.array(z.enum(["user", "workspace", "study", "system"])).max(4).default([]),
  limit: z.number().int().min(1).max(20).default(8),
});

function chunkText(content: string, targetLength = 1200) {
  const paragraphs = content.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs.length ? paragraphs : [content]) {
    if (current && current.length + paragraph.length + 2 > targetLength) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length <= targetLength) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }
    if (current) chunks.push(current);
    for (let offset = 0; offset < paragraph.length; offset += targetLength) {
      chunks.push(paragraph.slice(offset, offset + targetLength));
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function queryTerms(query: string) {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  const words = normalized.match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  const terms = words.flatMap((word) => {
    if (!/[\p{Script=Han}]/u.test(word) || word.length <= 4) return [word];
    return [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))];
  });
  return [...new Set(terms)].slice(0, 40);
}

function embeddingTokens(value: string) {
  const normalized = value.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  const terms = queryTerms(normalized);
  const characters = [...normalized.replace(/\s/g, "")];
  const ngrams = characters.flatMap((_, index) => [
    characters.slice(index, index + 2).join(""),
    characters.slice(index, index + 3).join(""),
  ]).filter((item) => item.length >= 2);
  return [...terms, ...ngrams].slice(0, 2000);
}

export function createContextEmbedding(value: string) {
  const vector = Array.from({ length: CONTEXT_EMBEDDING_BASELINE.dimensions }, () => 0);
  for (const token of embeddingTokens(value)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % vector.length;
    vector[index] += digest[4] % 2 === 0 ? 1 : -1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return magnitude ? vector.map((item) => Number((item / magnitude).toFixed(8))) : vector;
}

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0;
  return left.reduce((sum, item, index) => sum + item * right[index], 0);
}

function scoreCandidate(query: string, terms: string[], candidate: { title: string; content: string; asset_type: string }) {
  const title = candidate.title.toLowerCase();
  const content = candidate.content.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (content.includes(query.toLowerCase())) { score += 12; reasons.push("exact_content"); }
  if (title.includes(query.toLowerCase())) { score += 16; reasons.push("exact_title"); }
  for (const term of terms) {
    if (title.includes(term)) score += 4;
    if (content.includes(term)) score += 1;
  }
  if (terms.some((term) => title.includes(term))) reasons.push("title_term");
  if (terms.some((term) => content.includes(term))) reasons.push("content_term");
  if (candidate.asset_type.endsWith("memory")) { score += 0.25; reasons.push("memory_tiebreak"); }
  return { score, reasons };
}

async function insertVersion(
  transaction: Queryable,
  input: { assetId: string; version: number; content: string; changeNote: string; userId: string },
) {
  const version = await transaction.query<{ id: string; public_id: string }>(
    `insert into context_asset_versions (public_id, asset_id, version, content, change_note, created_by)
     values ($1, $2, $3, $4::jsonb, $5, $6)
     returning id::text as id, public_id`,
    [createPublicId("cxv"), input.assetId, input.version, JSON.stringify({ text: input.content }), input.changeNote, input.userId],
  );
  for (const [ordinal, chunk] of chunkText(input.content).entries()) {
    const embedding = createContextEmbedding(chunk);
    await transaction.query(
      `insert into context_chunks (
         public_id, asset_version_id, ordinal, content, metadata, embedding,
         embedding_model, embedding_dimensions, embedding_indexed_at, index_generation
       ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, now(), 1)`,
      [
        createPublicId("cxc"), version.rows[0].id, ordinal, chunk,
        JSON.stringify({ characters: chunk.length, embeddingVersion: CONTEXT_EMBEDDING_BASELINE.version }),
        JSON.stringify(embedding), CONTEXT_EMBEDDING_BASELINE.model, embedding.length,
      ],
    );
  }
  return version.rows[0];
}

export async function listContextAssets(viewer: Viewer) {
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string; asset_type: string; scope: ContextScope; title: string; description: string;
    source_uri: string | null; current_version: number; status: string; updated_at: string;
    study_public_id: string | null;
  }>(
    `select asset.public_id, asset.asset_type, asset.scope, asset.title, asset.description,
            asset.source_uri, asset.current_version, asset.status,
            asset.updated_at::text as updated_at, study.public_id as study_public_id
     from context_assets asset
     left join studies study on study.id = asset.study_id
     where asset.workspace_id = $1 and (asset.scope <> 'user' or asset.created_by = $2)
     order by asset.updated_at desc, asset.id desc limit 100`,
    [viewer.workspaceId, viewer.userId],
  );
  return result.rows.map((row) => ({
    publicId: row.public_id,
    assetType: row.asset_type,
    scope: row.scope,
    title: row.title,
    description: row.description,
    sourceUri: row.source_uri,
    studyPublicId: row.study_public_id,
    currentVersion: row.current_version,
    status: row.status,
    updatedAt: row.updated_at,
  }));
}

export async function createContextAsset(viewer: Viewer, input: z.infer<typeof contextAssetInputSchema>) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    let studyId: string | null = null;
    if (input.studyPublicId) {
      const study = await transaction.query<{ id: string }>(
        "select id::text as id from studies where public_id = $1 and workspace_id = $2 limit 1",
        [input.studyPublicId, viewer.workspaceId],
      );
      if (!study.rows[0]) return "study_not_found" as const;
      studyId = study.rows[0].id;
    }
    const asset = await transaction.query<{ id: string; public_id: string }>(
      `insert into context_assets (
         public_id, workspace_id, created_by, asset_type, scope, study_id, title, description, source_uri
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id::text as id, public_id`,
      [createPublicId("cxa"), viewer.workspaceId, viewer.userId, input.assetType, input.scope, studyId, input.title, input.description, input.sourceUri],
    );
    const version = await insertVersion(transaction, {
      assetId: asset.rows[0].id, version: 1, content: input.content, changeNote: input.changeNote, userId: viewer.userId,
    });
    return { publicId: asset.rows[0].public_id, versionPublicId: version.public_id, version: 1 };
  });
}

export async function publishContextVersion(
  viewer: Viewer,
  publicId: string,
  input: z.infer<typeof contextVersionInputSchema>,
) {
  if (viewer.role === "viewer") return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; current_version: number; created_by: string; scope: ContextScope }>(
      `select id::text as id, current_version, created_by::text as created_by, scope
       from context_assets where public_id = $1 and workspace_id = $2 for update`,
      [publicId, viewer.workspaceId],
    );
    const asset = result.rows[0];
    if (!asset) return "not_found" as const;
    if ((asset.scope === "user" || viewer.role === "member") && asset.created_by !== viewer.userId) return "forbidden" as const;
    const versionNumber = asset.current_version + 1;
    const version = await insertVersion(transaction, {
      assetId: asset.id, version: versionNumber, content: input.content, changeNote: input.changeNote, userId: viewer.userId,
    });
    await transaction.query(
      "update context_assets set current_version = $2, updated_at = now() where id = $1",
      [asset.id, versionNumber],
    );
    return { publicId, versionPublicId: version.public_id, version: versionNumber };
  });
}

export async function retrieveContext(input: {
  workspaceId: string;
  userId: string | null;
  query: string;
  assetTypes?: string[];
  scopes?: ContextScope[];
  limit?: number;
  studyId?: string;
  runId?: string;
  interviewSessionId?: string;
  audit?: boolean;
}): Promise<ContextSnapshot> {
  const database = await getDatabase();
  if (input.runId && input.audit !== false) {
    const existing = await loadRunContextSnapshot(database, input.runId, input.workspaceId);
    if (existing) return existing;
  }
  if (input.interviewSessionId && input.audit !== false) {
    const existing = await loadInterviewContextSnapshot(database, input.interviewSessionId, input.workspaceId);
    if (existing) return existing;
  }
  const terms = queryTerms(input.query);
  const patterns = terms.map((term) => `%${term}%`);
  const result = await database.query<{
    chunk_id: string; chunk_public_id: string; content: string; asset_public_id: string;
    version_public_id: string; version: number; asset_type: string; scope: ContextScope;
    title: string; source_uri: string | null;
  }>(
    `select chunk.id::text as chunk_id, chunk.public_id as chunk_public_id, chunk.content,
            asset.public_id as asset_public_id, version.public_id as version_public_id,
            version.version, asset.asset_type, asset.scope, asset.title, asset.source_uri
     from context_chunks chunk
     join context_asset_versions version on version.id = chunk.asset_version_id
     join context_assets asset on asset.id = version.asset_id and asset.current_version = version.version
     where asset.workspace_id = $1 and asset.status = 'active'
       and (asset.scope <> 'user' or asset.created_by = $2)
       and (cardinality($3::text[]) = 0 or asset.asset_type = any($3::text[]))
       and (cardinality($4::text[]) = 0 or asset.scope = any($4::text[]))
       and (asset.scope <> 'study' or asset.study_id = $5)
       and (cardinality($6::text[]) = 0 or asset.title ilike any($6::text[]) or chunk.content ilike any($6::text[]))
     order by asset.updated_at desc, chunk.ordinal
     limit 300`,
    [input.workspaceId, input.userId, input.assetTypes ?? [], input.scopes ?? [], input.studyId ?? null, patterns],
  );
  const ranked = result.rows
    .map((row) => ({ row, ...scoreCandidate(input.query, terms, row) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 8);
  const citations: ContextCitation[] = ranked.map(({ row, score, reasons }) => ({
    chunkPublicId: row.chunk_public_id,
    assetPublicId: row.asset_public_id,
    assetVersionPublicId: row.version_public_id,
    assetType: row.asset_type,
    scope: row.scope,
    title: row.title,
    sourceUri: row.source_uri,
    version: row.version,
    content: row.content,
    score,
    reasons,
  }));
  if (input.audit === false) {
    return { retrievalId: null, retrievalPublicId: null, strategy: "lexical_metadata_v1", query: input.query, citations };
  }
  return database.transaction(async (transaction) => {
    const retrieval = await transaction.query<{ id: string; public_id: string }>(
      `insert into context_retrievals (
         public_id, workspace_id, created_by, study_id, run_id, interview_session_id,
         query, strategy, filters
       ) values ($1, $2, $3, $4, $5, $6, $7, 'lexical_metadata_v1', $8::jsonb)
       on conflict do nothing
       returning id::text as id, public_id`,
      [
        createPublicId("cxr"), input.workspaceId, input.userId, input.studyId ?? null, input.runId ?? null,
        input.interviewSessionId ?? null, input.query,
        JSON.stringify({ assetTypes: input.assetTypes ?? [], scopes: input.scopes ?? [] }),
      ],
    );
    if (!retrieval.rows[0]) {
      const existing = input.runId
        ? await loadRunContextSnapshot(transaction, input.runId, input.workspaceId)
        : input.interviewSessionId
          ? await loadInterviewContextSnapshot(transaction, input.interviewSessionId, input.workspaceId)
          : null;
      if (existing) return existing;
      throw new Error("CONTEXT_RETRIEVAL_CONFLICT");
    }
    for (const [index, item] of ranked.entries()) {
      await transaction.query(
        `insert into context_retrieval_items (retrieval_id, chunk_id, rank, score, reasons)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [retrieval.rows[0].id, item.row.chunk_id, index + 1, item.score, JSON.stringify(item.reasons)],
      );
    }
    return {
      retrievalId: retrieval.rows[0].id,
      retrievalPublicId: retrieval.rows[0].public_id,
      strategy: "lexical_metadata_v1" as const,
      query: input.query,
      citations,
    };
  });
}

async function loadInterviewContextSnapshot(
  database: Queryable,
  interviewSessionId: string,
  workspaceId: string,
) {
  return loadContextSnapshot(database, "interview_session_id", interviewSessionId, workspaceId);
}

async function loadRunContextSnapshot(
  database: Queryable,
  runId: string,
  workspaceId: string,
): Promise<ContextSnapshot | null> {
  return loadContextSnapshot(database, "run_id", runId, workspaceId);
}

async function loadContextSnapshot(
  database: Queryable,
  binding: "run_id" | "interview_session_id",
  bindingId: string,
  workspaceId: string,
): Promise<ContextSnapshot | null> {
  const retrieval = await database.query<{
    id: string; public_id: string; query: string; strategy: "lexical_metadata_v1";
  }>(
    `select id::text as id, public_id, query, strategy
     from context_retrievals where ${binding} = $1 and workspace_id = $2
     order by created_at, id limit 1`,
    [bindingId, workspaceId],
  );
  const record = retrieval.rows[0];
  if (!record) return null;
  const items = await database.query<{
    chunk_public_id: string; asset_public_id: string; version_public_id: string;
    asset_type: string; scope: ContextScope; title: string; source_uri: string | null;
    version: number; content: string; score: number; reasons: string[] | string;
  }>(
    `select chunk.public_id as chunk_public_id, asset.public_id as asset_public_id,
            asset_version.public_id as version_public_id, asset.asset_type, asset.scope,
            asset.title, asset.source_uri, asset_version.version, chunk.content,
            item.score, item.reasons
     from context_retrieval_items item
     join context_chunks chunk on chunk.id = item.chunk_id
     join context_asset_versions asset_version on asset_version.id = chunk.asset_version_id
     join context_assets asset on asset.id = asset_version.asset_id
     where item.retrieval_id = $1 order by item.rank`,
    [record.id],
  );
  return {
    retrievalId: record.id,
    retrievalPublicId: record.public_id,
    strategy: record.strategy,
    query: record.query,
    citations: items.rows.map((item) => ({
      chunkPublicId: item.chunk_public_id,
      assetPublicId: item.asset_public_id,
      assetVersionPublicId: item.version_public_id,
      assetType: item.asset_type,
      scope: item.scope,
      title: item.title,
      sourceUri: item.source_uri,
      version: item.version,
      content: item.content,
      score: item.score,
      reasons: typeof item.reasons === "string" ? JSON.parse(item.reasons) as string[] : item.reasons,
    })),
  };
}

export function formatContextForPrompt(snapshot: ContextSnapshot, maxCharacters = 6000) {
  if (!snapshot.citations.length) return "";
  let remaining = maxCharacters;
  const entries: string[] = [];
  for (const citation of snapshot.citations) {
    const entry = `[Context: ${citation.title} v${citation.version} / ${citation.chunkPublicId}]\n${citation.content}`;
    if (remaining <= 0) break;
    entries.push(entry.slice(0, remaining));
    remaining -= entry.length;
  }
  return entries.join("\n\n");
}
