import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as cheerio from "cheerio";
import type { Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export const SOURCE_CONNECTOR_POLICY_VERSION = "public-source-policy-v1";
export const SOURCE_RESPONSE_BYTE_LIMIT = 1_500_000;
export const SOURCE_PAGE_TEXT_LIMIT = 5_000;

function stripNullBytes(value: string | null | undefined) {
  return value == null ? value ?? null : value.replace(/\u0000/g, "");
}

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, nested) => (
    typeof nested === "string" ? stripNullBytes(nested) : nested
  )) ?? "null";
}

export type SourceProvider = "seed" | "tavily" | "bing";
export type SourceCandidateStatus = "discovered" | "collected" | "rejected" | "unavailable" | "removed";

export type ConnectorCapabilities = {
  search: boolean;
  collect: boolean;
  robotsPolicy: boolean;
  immutableSnapshots: boolean;
  authenticatedSources: false;
};

export type SourceConnector<Query> = {
  search(query: Query, signal?: AbortSignal): Promise<SourceCandidate[]>;
  collect(candidate: SourceCandidate, signal?: AbortSignal): Promise<CollectedSourceCandidate>;
  capabilities(): ConnectorCapabilities;
};

export type SourceCandidate = {
  publicId: string;
  provider: SourceProvider;
  query: string | null;
  rank: number | null;
  score: number | null;
  title: string;
  url: string;
  providerExcerpt?: string;
};

export type SourceSnapshot = {
  publicId: string;
  status: "available" | "unavailable" | "removed";
  canonicalUrl: string;
  httpStatus: number | null;
  contentType: string | null;
  contentLength: number | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  rawContent: string | null;
  normalizedText: string | null;
  fetchedAt: string;
  metadata: Record<string, unknown>;
};

export type SourceObservation = {
  publicId: string;
  key: string;
  kind: "page_excerpt";
  content: string;
  confidence: "high" | "medium" | "low";
  locator: Record<string, unknown>;
  coding: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type CollectedSourceCandidate = SourceCandidate & {
  canonicalUrl: string;
  status: Exclude<SourceCandidateStatus, "discovered" | "removed">;
  rejectionReason: string | null;
  resolvedTitle: string;
  snapshot: SourceSnapshot | null;
  observation: SourceObservation | null;
  metadata: Record<string, unknown>;
};

export type SourceConnectorAudit = {
  publicId: string;
  connectorKey: "public-web";
  provider: "tavily" | "bing";
  policyVersion: string;
  status: "completed" | "partial" | "failed";
  queries: string[];
  startedAt: string;
  finishedAt: string;
  candidateCount: number;
  collectedCount: number;
  rejectedCount: number;
  unavailableCount: number;
  candidates: CollectedSourceCandidate[];
  metadata: Record<string, unknown>;
};

export type SourceConnectorAuditSummary = Omit<SourceConnectorAudit, "candidates"> & {
  candidates: Array<Omit<CollectedSourceCandidate, "providerExcerpt" | "snapshot" | "observation"> & {
    snapshot: null | Omit<SourceSnapshot, "rawContent" | "normalizedText">;
    observation: null | Omit<SourceObservation, "content">;
  }>;
};

type LookupHost = (hostname: string) => Promise<Array<{ address: string }>>;
type ConnectorDependencies = {
  fetchImpl?: typeof fetch;
  lookupHost?: LookupHost;
  signal?: AbortSignal;
};

class SourceCollectionError extends Error {
  constructor(
    readonly code: string,
    readonly metadata: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "SourceCollectionError";
  }
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

export function canonicalizeSourceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  return url.toString();
}

async function assertPublicSourceUrl(value: string, lookupHost: LookupHost) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SourceCollectionError("SOURCE_UNSAFE_URL");
  if (url.username || url.password) throw new SourceCollectionError("SOURCE_URL_CREDENTIALS");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new SourceCollectionError("SOURCE_UNSAFE_URL");
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new SourceCollectionError("SOURCE_UNSAFE_URL");
  } else {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookupHost(hostname);
    } catch {
      throw new SourceCollectionError("SOURCE_DNS_UNAVAILABLE");
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new SourceCollectionError("SOURCE_UNSAFE_URL");
    }
  }
  return url;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchWithControlledRedirects(
  value: string,
  options: ConnectorDependencies & { accept: string; timeoutMs: number },
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupHost = options.lookupHost ?? (async (hostname) => lookup(hostname, { all: true }));
  let url = await assertPublicSourceUrl(value, lookupHost);

  for (let redirectCount = 0; redirectCount < 4; redirectCount += 1) {
    const response = await fetchImpl(url, {
      redirect: "manual",
      credentials: "omit",
      signal: requestSignal(options.signal, options.timeoutMs),
      headers: {
        "user-agent": "atypica-research/1.0 (+public-source-audit)",
        accept: options.accept,
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new SourceCollectionError("SOURCE_REDIRECT_MISSING", { httpStatus: response.status });
      url = await assertPublicSourceUrl(new URL(location, url).toString(), lookupHost);
      continue;
    }
    return { response, url };
  }
  throw new SourceCollectionError("SOURCE_TOO_MANY_REDIRECTS");
}

async function readLimitedText(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > SOURCE_RESPONSE_BYTE_LIMIT) {
    throw new SourceCollectionError("SOURCE_TOO_LARGE", { contentLength: declaredLength });
  }
  if (!response.body) return { text: "", bytesRead: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > SOURCE_RESPONSE_BYTE_LIMIT) throw new SourceCollectionError("SOURCE_TOO_LARGE", { contentLength: bytesRead });
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode(), bytesRead };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function robotsPatternMatches(path: string, pattern: string) {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}

function isRobotsAllowed(robotsText: string, target: URL) {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let group: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;
  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (key === "allow" || key === "disallow")) {
      if (value) group.rules.push({ allow: key === "allow", path: value });
    }
  }
  const matching = groups.filter((item) => item.agents.some((agent) => agent === "atypica-research" || agent === "*"));
  const path = `${target.pathname}${target.search}`;
  const rules = matching.flatMap((item) => item.rules).filter((rule) => robotsPatternMatches(path, rule.path));
  rules.sort((left, right) => right.path.length - left.path.length || Number(right.allow) - Number(left.allow));
  return rules[0]?.allow ?? true;
}

async function assertRobotsAllowed(url: URL, options: ConnectorDependencies) {
  const robotsUrl = new URL("/robots.txt", url.origin);
  const { response } = await fetchWithControlledRedirects(robotsUrl.toString(), {
    ...options,
    accept: "text/plain,*/*;q=0.1",
    timeoutMs: 7_000,
  });
  if (response.status === 404 || response.status === 410) return;
  if (response.status === 401 || response.status === 403) throw new SourceCollectionError("SOURCE_ROBOTS_DENIED", { robotsStatus: response.status });
  if (!response.ok) throw new SourceCollectionError("SOURCE_ROBOTS_UNAVAILABLE", { robotsStatus: response.status });
  const { text } = await readLimitedText(response);
  if (!isRobotsAllowed(text, url)) throw new SourceCollectionError("SOURCE_ROBOTS_DENIED");
}

function extractPageText(html: string) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, nav, footer, form").remove();
  const root = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body");
  return root.text().replace(/\s+/g, " ").trim().slice(0, SOURCE_PAGE_TEXT_LIMIT);
}

function extractPageTitle(html: string, fallbackUrl: string) {
  const $ = cheerio.load(html);
  return $("meta[property='og:title']").attr("content")?.trim()
    || $("title").first().text().replace(/\s+/g, " ").trim()
    || $("h1").first().text().replace(/\s+/g, " ").trim()
    || new URL(fallbackUrl).hostname;
}

function extractCanonicalUrl(html: string, fetchedUrl: URL) {
  const href = cheerio.load(html)("link[rel='canonical']").first().attr("href");
  if (!href) return canonicalizeSourceUrl(fetchedUrl.toString());
  try {
    const canonical = new URL(href, fetchedUrl);
    return canonical.hostname.toLowerCase() === fetchedUrl.hostname.toLowerCase()
      ? canonicalizeSourceUrl(canonical.toString())
      : canonicalizeSourceUrl(fetchedUrl.toString());
  } catch {
    return canonicalizeSourceUrl(fetchedUrl.toString());
  }
}

function looksAccessRestricted(html: string, normalizedText: string) {
  const title = cheerio.load(html)("title").first().text().toLowerCase();
  const sample = `${title}\n${normalizedText.slice(0, 1800).toLowerCase()}`;
  return /captcha|verify you are human|access denied|sign in to continue|log in to continue|subscribe to continue|enable javascript and cookies/.test(sample);
}

function classifyCollectionError(error: unknown) {
  const code = error instanceof SourceCollectionError
    ? error.code
    : error instanceof Error && error.name === "TimeoutError"
      ? "SOURCE_TIMEOUT"
      : "SOURCE_FETCH_FAILED";
  const rejected = new Set([
    "SOURCE_UNSAFE_URL", "SOURCE_URL_CREDENTIALS", "SOURCE_ROBOTS_DENIED", "SOURCE_NOT_TEXT",
    "SOURCE_TOO_LARGE", "SOURCE_ACCESS_RESTRICTED", "SOURCE_REDIRECT_MISSING", "SOURCE_TOO_MANY_REDIRECTS",
  ]);
  return {
    code,
    status: rejected.has(code) ? "rejected" as const : "unavailable" as const,
    metadata: error instanceof SourceCollectionError ? error.metadata : {},
  };
}

export async function collectSourceCandidate(candidate: SourceCandidate, options: ConnectorDependencies = {}): Promise<CollectedSourceCandidate> {
  const fetchedAt = new Date().toISOString();
  let canonicalUrl: string;
  try {
    const lookupHost = options.lookupHost ?? (async (hostname) => lookup(hostname, { all: true }));
    const initialUrl = await assertPublicSourceUrl(candidate.url, lookupHost);
    canonicalUrl = canonicalizeSourceUrl(initialUrl.toString());
    await assertRobotsAllowed(initialUrl, options);
    const { response, url } = await fetchWithControlledRedirects(initialUrl.toString(), {
      ...options,
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      timeoutMs: 10_000,
    });
    if (!response.ok) throw new SourceCollectionError(`SOURCE_HTTP_${response.status}`, { httpStatus: response.status });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml+xml")) {
      throw new SourceCollectionError("SOURCE_NOT_TEXT", { contentType });
    }
    const { text: fetchedContent, bytesRead } = await readLimitedText(response);
    const rawContent = stripNullBytes(fetchedContent) ?? "";
    const normalizedText = contentType.includes("text/plain")
      ? rawContent.replace(/\s+/g, " ").trim().slice(0, SOURCE_PAGE_TEXT_LIMIT)
      : extractPageText(rawContent);
    if (looksAccessRestricted(rawContent, normalizedText)) throw new SourceCollectionError("SOURCE_ACCESS_RESTRICTED", { httpStatus: response.status });
    if (normalizedText.length < 120) throw new SourceCollectionError("SOURCE_TEXT_TOO_SHORT", { textLength: normalizedText.length });
    canonicalUrl = extractCanonicalUrl(rawContent, url);
    const snapshot: SourceSnapshot = {
      publicId: createPublicId("snp"),
      status: "available",
      canonicalUrl,
      httpStatus: response.status,
      contentType: contentType || null,
      contentLength: bytesRead,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      contentHash: createHash("sha256").update(rawContent).digest("hex"),
      rawContent,
      normalizedText,
      fetchedAt,
      metadata: { robotsChecked: true, redirectPolicy: "manual-public-only" },
    };
    const observation: SourceObservation = {
      publicId: createPublicId("obs"),
      key: "page-excerpt-01",
      kind: "page_excerpt",
      content: normalizedText,
      confidence: "high",
      locator: { url: canonicalUrl, startCharacter: 0, endCharacter: normalizedText.length },
      coding: {},
      metadata: { snapshotPublicId: snapshot.publicId, contentHash: snapshot.contentHash },
    };
    return {
      ...candidate,
      canonicalUrl,
      status: "collected",
      rejectionReason: null,
      resolvedTitle: extractPageTitle(rawContent, canonicalUrl),
      snapshot,
      observation,
      metadata: { providerExcerptPresent: Boolean(candidate.providerExcerpt) },
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    const classified = classifyCollectionError(error);
    canonicalUrl = (() => {
      try { return canonicalizeSourceUrl(candidate.url); } catch { return candidate.url; }
    })();
    return {
      ...candidate,
      canonicalUrl,
      status: classified.status,
      rejectionReason: classified.code,
      resolvedTitle: candidate.title,
      snapshot: classified.status === "unavailable" ? {
        publicId: createPublicId("snp"),
        status: "unavailable",
        canonicalUrl,
        httpStatus: typeof classified.metadata.httpStatus === "number" ? classified.metadata.httpStatus : null,
        contentType: typeof classified.metadata.contentType === "string" ? classified.metadata.contentType : null,
        contentLength: typeof classified.metadata.contentLength === "number" ? classified.metadata.contentLength : null,
        etag: null,
        lastModified: null,
        contentHash: null,
        rawContent: null,
        normalizedText: null,
        fetchedAt,
        metadata: { reason: classified.code, ...classified.metadata },
      } : null,
      observation: null,
      metadata: classified.metadata,
    };
  }
}

export function summarizeSourceConnectorAudit(audit: SourceConnectorAudit): SourceConnectorAuditSummary {
  return {
    ...audit,
    candidates: audit.candidates.map((candidate) => {
      const { snapshot, observation } = candidate;
      const summary = {
        publicId: candidate.publicId,
        provider: candidate.provider,
        query: candidate.query,
        rank: candidate.rank,
        score: candidate.score,
        title: candidate.title,
        url: candidate.url,
        canonicalUrl: candidate.canonicalUrl,
        status: candidate.status,
        rejectionReason: candidate.rejectionReason,
        resolvedTitle: candidate.resolvedTitle,
        metadata: candidate.metadata,
      };
      return {
        ...summary,
        snapshot: snapshot ? {
          publicId: snapshot.publicId,
          status: snapshot.status,
          canonicalUrl: snapshot.canonicalUrl,
          httpStatus: snapshot.httpStatus,
          contentType: snapshot.contentType,
          contentLength: snapshot.contentLength,
          etag: snapshot.etag,
          lastModified: snapshot.lastModified,
          contentHash: snapshot.contentHash,
          fetchedAt: snapshot.fetchedAt,
          metadata: snapshot.metadata,
        } : null,
        observation: observation ? {
          publicId: observation.publicId,
          key: observation.key,
          kind: observation.kind,
          confidence: observation.confidence,
          locator: observation.locator,
          coding: observation.coding,
          metadata: observation.metadata,
        } : null,
      };
    }),
  };
}

export function buildSourceConnectorAudit(input: {
  publicId?: string;
  provider: "tavily" | "bing";
  queries: string[];
  startedAt: string;
  candidates: CollectedSourceCandidate[];
  metadata?: Record<string, unknown>;
}): SourceConnectorAudit {
  const collectedCount = input.candidates.filter((candidate) => candidate.status === "collected").length;
  const rejectedCount = input.candidates.filter((candidate) => candidate.status === "rejected").length;
  const unavailableCount = input.candidates.filter((candidate) => candidate.status === "unavailable").length;
  return {
    publicId: input.publicId ?? createPublicId("scr"),
    connectorKey: "public-web",
    provider: input.provider,
    policyVersion: SOURCE_CONNECTOR_POLICY_VERSION,
    status: collectedCount === 0 ? "failed" : rejectedCount || unavailableCount ? "partial" : "completed",
    queries: input.queries,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    candidateCount: input.candidates.length,
    collectedCount,
    rejectedCount,
    unavailableCount,
    candidates: input.candidates,
    metadata: input.metadata ?? {},
  };
}

export async function materializeSourceConnectorAudit(queryable: Queryable, input: {
  workspaceId: string;
  studyId: string;
  runId: string;
  taskKey: string;
  attempt: number;
  audit: SourceConnectorAudit;
}) {
  const run = await queryable.query<{ id: string }>(
    `insert into source_connector_runs (
       public_id, workspace_id, study_id, run_id, task_key, attempt, connector_key, provider,
       policy_version, status, query_plan, candidate_count, collected_count, rejected_count,
       unavailable_count, metadata, started_at, finished_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16::jsonb, $17, $18)
     returning id::text as id`,
    [
      input.audit.publicId, input.workspaceId, input.studyId, input.runId, input.taskKey, input.attempt,
      input.audit.connectorKey, input.audit.provider, input.audit.policyVersion, input.audit.status,
      stringifyJson(input.audit.queries), input.audit.candidateCount, input.audit.collectedCount,
      input.audit.rejectedCount, input.audit.unavailableCount, stringifyJson(input.audit.metadata),
      stripNullBytes(input.audit.startedAt), stripNullBytes(input.audit.finishedAt),
    ],
  );
  for (const candidate of input.audit.candidates) {
    const storedCandidate = await queryable.query<{ id: string }>(
      `insert into source_candidates (
         public_id, connector_run_id, provider, query, provider_rank, provider_score, title,
         source_url, canonical_url, status, rejection_reason, metadata, collected_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
       returning id::text as id`,
      [
        stripNullBytes(candidate.publicId), run.rows[0].id, stripNullBytes(candidate.provider), stripNullBytes(candidate.query), candidate.rank, candidate.score,
        stripNullBytes(candidate.resolvedTitle), stripNullBytes(candidate.url), stripNullBytes(candidate.canonicalUrl), stripNullBytes(candidate.status), stripNullBytes(candidate.rejectionReason),
        stringifyJson(candidate.metadata), candidate.status === "collected" ? stripNullBytes(candidate.snapshot?.fetchedAt) : null,
      ],
    );
    if (!candidate.snapshot) continue;
    const snapshot = await queryable.query<{ id: string }>(
      `insert into source_snapshots (
         public_id, candidate_id, status, canonical_url, http_status, content_type, content_length,
         etag, last_modified, content_hash, raw_content, normalized_text, fetched_at, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       returning id::text as id`,
      [
        stripNullBytes(candidate.snapshot.publicId), storedCandidate.rows[0].id, stripNullBytes(candidate.snapshot.status),
        stripNullBytes(candidate.snapshot.canonicalUrl), candidate.snapshot.httpStatus, stripNullBytes(candidate.snapshot.contentType),
        candidate.snapshot.contentLength, stripNullBytes(candidate.snapshot.etag), stripNullBytes(candidate.snapshot.lastModified),
        stripNullBytes(candidate.snapshot.contentHash), stripNullBytes(candidate.snapshot.rawContent), stripNullBytes(candidate.snapshot.normalizedText),
        stripNullBytes(candidate.snapshot.fetchedAt), stringifyJson(candidate.snapshot.metadata),
      ],
    );
    if (!candidate.observation) continue;
    await queryable.query(
      `insert into source_observations (
         public_id, candidate_id, snapshot_id, observation_key, observation_kind, content,
         confidence, locator, coding, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [
        stripNullBytes(candidate.observation.publicId), storedCandidate.rows[0].id, snapshot.rows[0].id,
        stripNullBytes(candidate.observation.key), stripNullBytes(candidate.observation.kind), stripNullBytes(candidate.observation.content),
        stripNullBytes(candidate.observation.confidence), stringifyJson(candidate.observation.locator),
        stringifyJson(candidate.observation.coding), stringifyJson(candidate.observation.metadata),
      ],
    );
  }
}

export async function markSourceCandidateUnavailable(
  queryable: Queryable,
  candidatePublicId: string,
  status: "unavailable" | "removed",
  reason: string,
) {
  const candidate = await queryable.query<{ id: string; canonical_url: string }>(
    `update source_candidates
     set status = $2, rejection_reason = $3, updated_at = now()
     where public_id = $1
     returning id::text as id, canonical_url`,
    [candidatePublicId, status, reason],
  );
  if (!candidate.rows[0]) return null;
  const snapshotPublicId = createPublicId("snp");
  await queryable.query(
    `insert into source_snapshots (
       public_id, candidate_id, status, canonical_url, content_hash, raw_content,
       normalized_text, fetched_at, metadata
     ) values ($1, $2, $3, $4, null, null, null, now(), $5::jsonb)`,
    [snapshotPublicId, candidate.rows[0].id, status, candidate.rows[0].canonical_url, JSON.stringify({ reason })],
  );
  return snapshotPublicId;
}
