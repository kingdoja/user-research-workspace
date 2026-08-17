import { createHash } from "node:crypto";
import { z } from "zod";
import { createPublicId } from "@/lib/identifiers";
import {
  buildSourceConnectorAudit,
  type CollectedSourceCandidate,
  type SourceCandidate,
  type SourceConnectorAudit,
} from "@/lib/source-connectors";

export const BLUESKY_CONNECTOR_POLICY_VERSION = "bluesky-public-api-policy-v1";
const DEFAULT_BLUESKY_API_URL = "https://public.api.bsky.app";
const BLUESKY_RESPONSE_BYTE_LIMIT = 2_000_000;

const postViewSchema = z.object({
  uri: z.string().startsWith("at://"),
  cid: z.string().min(1),
  author: z.object({
    did: z.string().startsWith("did:"),
    handle: z.string().min(1),
    displayName: z.string().optional(),
  }).passthrough(),
  record: z.object({
    text: z.string(),
    createdAt: z.string(),
    langs: z.array(z.string()).optional(),
  }).passthrough(),
  replyCount: z.number().int().nonnegative().optional(),
  repostCount: z.number().int().nonnegative().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  quoteCount: z.number().int().nonnegative().optional(),
  indexedAt: z.string().optional(),
}).passthrough();

const searchResponseSchema = z.object({ posts: z.array(postViewSchema) }).passthrough();
const getPostsResponseSchema = z.object({ posts: z.array(postViewSchema) }).passthrough();
type BlueskyPostView = z.infer<typeof postViewSchema>;

export type BlueskySourceCandidate = SourceCandidate & {
  provider: "bluesky";
  upstreamUri: string;
  upstreamCid: string;
};

type BlueskyDependencies = {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  signal?: AbortSignal;
};

function blueskyApiOrigin(configured?: string) {
  const url = new URL(configured ?? process.env.BLUESKY_PUBLIC_API_URL?.trim() ?? DEFAULT_BLUESKY_API_URL);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("BLUESKY_API_URL_UNSAFE");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function requestSignal(signal: AbortSignal | undefined) {
  const timeout = AbortSignal.timeout(8_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function classifyBlueskyError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "BLUESKY_API_INVALID_RESPONSE";
  if (error instanceof Error && error.name === "TimeoutError") return "BLUESKY_API_TIMEOUT";
  if (error instanceof Error && /^BLUESKY_[A-Z0-9_]+(?:_\d{3})?$/.test(error.message)) return error.message;
  return "BLUESKY_API_UNAVAILABLE";
}

async function fetchJson(path: string, search: URLSearchParams, dependencies: BlueskyDependencies) {
  const url = new URL(path, blueskyApiOrigin(dependencies.apiUrl));
  url.search = search.toString();
  const response = await (dependencies.fetchImpl ?? fetch)(url, {
    credentials: "omit",
    signal: requestSignal(dependencies.signal),
    headers: {
      accept: "application/json",
      "user-agent": "atypica-research/1.0 (+official-bluesky-public-api)",
    },
  });
  if (!response.ok) throw new Error(`BLUESKY_API_HTTP_${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > BLUESKY_RESPONSE_BYTE_LIMIT) {
    throw new Error("BLUESKY_API_RESPONSE_TOO_LARGE");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > BLUESKY_RESPONSE_BYTE_LIMIT) throw new Error("BLUESKY_API_RESPONSE_TOO_LARGE");
  return JSON.parse(body) as unknown;
}

function postRkey(uri: string) {
  const parts = uri.split("/");
  const rkey = parts.at(-1);
  if (!rkey) throw new Error("BLUESKY_POST_URI_INVALID");
  return rkey;
}

function publicPostUrl(post: BlueskyPostView) {
  return `https://bsky.app/profile/${encodeURIComponent(post.author.handle)}/post/${encodeURIComponent(postRkey(post.uri))}`;
}

function candidateFromPost(post: BlueskyPostView, query: string, rank: number): BlueskySourceCandidate {
  return {
    publicId: createPublicId("src"),
    provider: "bluesky",
    query,
    rank,
    score: null,
    title: `${post.author.displayName?.trim() || post.author.handle} on Bluesky`,
    url: publicPostUrl(post),
    providerExcerpt: post.record.text.replace(/\s+/g, " ").trim().slice(0, 280),
    upstreamUri: post.uri,
    upstreamCid: post.cid,
    discoveryMetadata: {
      api: "app.bsky.feed.searchPosts",
      authorDid: post.author.did,
      authorHandle: post.author.handle,
      upstreamUri: post.uri,
      upstreamCid: post.cid,
    },
  };
}

export async function searchBlueskyPublicPosts(
  query: string,
  dependencies: BlueskyDependencies = {},
): Promise<BlueskySourceCandidate[]> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!normalizedQuery) return [];
  const payload = searchResponseSchema.parse(await fetchJson(
    "/xrpc/app.bsky.feed.searchPosts",
    new URLSearchParams({ q: normalizedQuery, limit: "4", sort: "latest" }),
    dependencies,
  ));
  return payload.posts.slice(0, 4).map((post, index) => candidateFromPost(post, normalizedQuery, index + 1));
}

export async function collectBlueskyPublicPost(
  candidate: BlueskySourceCandidate,
  dependencies: BlueskyDependencies = {},
): Promise<CollectedSourceCandidate> {
  const fetchedAt = new Date().toISOString();
  try {
    const payload = getPostsResponseSchema.parse(await fetchJson(
      "/xrpc/app.bsky.feed.getPosts",
      new URLSearchParams([["uris", candidate.upstreamUri]]),
      dependencies,
    ));
    const post = payload.posts.find((item) => item.uri === candidate.upstreamUri);
    if (!post) throw new Error("BLUESKY_POST_UNAVAILABLE");
    const rawContent = JSON.stringify(post);
    const normalizedText = post.record.text.replace(/\s+/g, " ").trim().slice(0, 5_000);
    if (!normalizedText) throw new Error("BLUESKY_POST_EMPTY");
    const canonicalUrl = publicPostUrl(post);
    const contentHash = createHash("sha256").update(rawContent).digest("hex");
    const snapshotPublicId = createPublicId("snp");
    return {
      ...candidate,
      canonicalUrl,
      status: "collected",
      rejectionReason: null,
      resolvedTitle: `${post.author.displayName?.trim() || post.author.handle} on Bluesky`,
      snapshot: {
        publicId: snapshotPublicId,
        status: "available",
        canonicalUrl,
        httpStatus: 200,
        contentType: "application/json",
        contentLength: Buffer.byteLength(rawContent, "utf8"),
        etag: post.cid,
        lastModified: post.indexedAt ?? null,
        contentHash,
        rawContent,
        rawStorage: null,
        rawByteLength: Buffer.byteLength(rawContent, "utf8"),
        normalizedText,
        fetchedAt,
        metadata: {
          officialApi: "app.bsky.feed.getPosts",
          policyVersion: BLUESKY_CONNECTOR_POLICY_VERSION,
          upstreamUri: post.uri,
          upstreamCid: post.cid,
          authorDid: post.author.did,
          authorHandle: post.author.handle,
          createdAt: post.record.createdAt,
          indexedAt: post.indexedAt ?? null,
          deletionState: "available",
        },
      },
      observation: {
        publicId: createPublicId("obs"),
        key: `social-post-${postRkey(post.uri)}`,
        kind: "social_post",
        content: normalizedText,
        confidence: "high",
        locator: {
          url: canonicalUrl,
          upstreamUri: post.uri,
          upstreamCid: post.cid,
          authorDid: post.author.did,
          authorHandle: post.author.handle,
          createdAt: post.record.createdAt,
        },
        coding: {},
        metadata: { snapshotPublicId, contentHash, officialApi: true },
      },
      metadata: {
        officialApi: true,
        upstreamUri: post.uri,
        upstreamCid: post.cid,
        authorDid: post.author.did,
        authorHandle: post.author.handle,
      },
    };
  } catch (error) {
    if (dependencies.signal?.aborted) throw dependencies.signal.reason ?? error;
    const reason = classifyBlueskyError(error);
    return {
      ...candidate,
      canonicalUrl: candidate.url,
      status: "unavailable",
      rejectionReason: reason,
      resolvedTitle: candidate.title,
      snapshot: {
        publicId: createPublicId("snp"),
        status: "unavailable",
        canonicalUrl: candidate.url,
        httpStatus: null,
        contentType: "application/json",
        contentLength: null,
        etag: candidate.upstreamCid,
        lastModified: null,
        contentHash: null,
        rawContent: null,
        rawStorage: null,
        rawByteLength: null,
        normalizedText: null,
        fetchedAt,
        metadata: {
          reason,
          officialApi: "app.bsky.feed.getPosts",
          upstreamUri: candidate.upstreamUri,
          deletionState: "unavailable",
        },
      },
      observation: null,
      metadata: { officialApi: true, upstreamUri: candidate.upstreamUri },
    };
  }
}

export type BlueskyCollectionResult = {
  sources: Array<{
    title: string;
    url: string;
    excerpt: string;
    connectorRunPublicId: string;
    candidatePublicId: string;
    snapshotPublicId: string;
    observationPublicId: string;
    contentHash: string;
    collectedAt: string;
  }>;
  audit: SourceConnectorAudit;
};

export async function collectBlueskyPublicSources(
  queries: string[],
  signal?: AbortSignal,
  dependencies: Omit<BlueskyDependencies, "signal"> = {},
): Promise<BlueskyCollectionResult> {
  const startedAt = new Date().toISOString();
  const providerErrors: string[] = [];
  const discoveredGroups = await Promise.all(queries.slice(0, 2).map(async (query) => {
    try { return await searchBlueskyPublicPosts(query, { ...dependencies, signal }); }
    catch (error) {
      providerErrors.push(classifyBlueskyError(error));
      return [];
    }
  }));
  const unique = new Map<string, BlueskySourceCandidate>();
  for (const candidate of discoveredGroups.flat()) {
    if (!unique.has(candidate.upstreamUri)) unique.set(candidate.upstreamUri, candidate);
  }
  const collected = await Promise.all([...unique.values()].slice(0, 8).map((candidate) => (
    collectBlueskyPublicPost(candidate, { ...dependencies, signal })
  )));
  const audit = buildSourceConnectorAudit({
    connectorKey: "bluesky-public",
    provider: "bluesky",
    policyVersion: BLUESKY_CONNECTOR_POLICY_VERSION,
    queries: queries.slice(0, 2),
    startedAt,
    candidates: collected,
    metadata: {
      officialApi: true,
      policyVersion: BLUESKY_CONNECTOR_POLICY_VERSION,
      providerErrors: [...new Set(providerErrors)].slice(0, 8),
    },
  });
  const sources = collected.flatMap((item) => (
    item.status === "collected" && item.snapshot?.contentHash && item.observation
      ? [{
          title: item.resolvedTitle,
          url: item.canonicalUrl,
          excerpt: item.observation.content,
          connectorRunPublicId: audit.publicId,
          candidatePublicId: item.publicId,
          snapshotPublicId: item.snapshot.publicId,
          observationPublicId: item.observation.publicId,
          contentHash: item.snapshot.contentHash,
          collectedAt: item.snapshot.fetchedAt,
        }]
      : []
  ));
  return { sources, audit };
}

export function getBlueskyPublicConnectorStatus() {
  return {
    enabled: process.env.BLUESKY_SOCIAL_CONNECTOR_ENABLED?.trim().toLowerCase() === "true",
    provider: "bluesky",
    api: "public-appview",
    authentication: "public",
    policyVersion: BLUESKY_CONNECTOR_POLICY_VERSION,
  } as const;
}
