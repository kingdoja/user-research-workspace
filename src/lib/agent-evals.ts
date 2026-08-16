import { createHash } from "node:crypto";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export type AgentEvalTrustDimension = "fabricated_citation" | "persona_convergence";
type AgentEvalSourceType = "context_asset_version" | "report_version" | "persona";

const sourceSchema = z.object({
  sourceType: z.enum(["context_asset_version", "report_version", "persona"]),
  sourcePublicId: z.string().trim().min(8).max(120),
});

export const agentEvalSuiteInputSchema = z.object({
  suiteKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  name: z.string().trim().min(2).max(180),
  description: z.string().trim().max(1000).default(""),
  cases: z.array(z.object({
    caseKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
    title: z.string().trim().min(2).max(240),
    trustDimension: z.enum(["fabricated_citation", "persona_convergence"]),
    instruction: z.string().trim().min(2).max(8000),
    expected: z.object({
      requiredCitationSourcePublicIds: z.array(z.string().trim().min(8).max(120)).max(30).default([]),
      minimumDistinctPersonaSources: z.number().int().min(1).max(20).default(2),
    }).default({ requiredCitationSourcePublicIds: [], minimumDistinctPersonaSources: 2 }),
    sources: z.array(sourceSchema).min(1).max(50),
  })).min(1).max(100),
});

export const agentEvalRunInputSchema = z.object({
  outputs: z.array(z.object({
    casePublicId: z.string().trim().min(8).max(120),
    summary: z.string().trim().max(20_000).default(""),
    citedSourcePublicIds: z.array(z.string().trim().min(8).max(120)).max(50).default([]),
    personaSourcePublicIds: z.array(z.string().trim().min(8).max(120)).max(50).default([]),
  })).min(1).max(100),
});

export const agentEvalLabelInputSchema = z.object({
  casePublicId: z.string().trim().min(8).max(120),
  label: z.enum(["pass", "fail", "needs_review"]),
  note: z.string().trim().max(2000).default(""),
});

function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function isAdmin(viewer: Viewer) {
  return viewer.role === "owner" || viewer.role === "admin";
}

type AuthorizedSource = {
  sourceType: AgentEvalSourceType;
  sourcePublicId: string;
  sourceHash: string;
  contextAssetVersionId: string | null;
  reportVersionId: string | null;
  personaId: string | null;
};

async function resolveAuthorizedSource(
  database: Queryable,
  workspaceId: string,
  source: z.infer<typeof sourceSchema>,
): Promise<AuthorizedSource | null> {
  if (source.sourceType === "context_asset_version") {
    const result = await database.query<{
      id: string; public_id: string; content_hash: string;
    }>(
      `select version.id::text as id, version.public_id, version.content_hash
       from context_asset_versions version
       join context_assets asset on asset.id = version.asset_id
       where version.public_id = $1 and asset.workspace_id = $2
         and asset.current_version = version.version and asset.status = 'active'
         and asset.review_status = 'approved'`,
      [source.sourcePublicId, workspaceId],
    );
    const row = result.rows[0];
    return row ? {
      sourceType: source.sourceType,
      sourcePublicId: row.public_id,
      sourceHash: row.content_hash,
      contextAssetVersionId: row.id,
      reportVersionId: null,
      personaId: null,
    } : null;
  }
  if (source.sourceType === "report_version") {
    const result = await database.query<{ id: string; public_id: string; content_json: Record<string, unknown> | string }>(
      `select version.id::text as id, version.public_id, version.content_json
       from report_versions version
       join studies study on study.id = version.study_id
       where version.public_id = $1 and study.workspace_id = $2 and version.status = 'published'`,
      [source.sourcePublicId, workspaceId],
    );
    const row = result.rows[0];
    return row ? {
      sourceType: source.sourceType,
      sourcePublicId: row.public_id,
      sourceHash: hashValue(JSON.stringify(parseJson(row.content_json))),
      contextAssetVersionId: null,
      reportVersionId: row.id,
      personaId: null,
    } : null;
  }
  const result = await database.query<{ id: string; public_id: string; profile: Record<string, unknown> | string }>(
    `select persona.id::text as id, persona.public_id, persona.profile
     from study_personas persona
     where persona.public_id = $1 and persona.workspace_id = $2
       and persona.retention_status = 'retained'
       and (persona.valid_until is null or persona.valid_until > now())`,
    [source.sourcePublicId, workspaceId],
  );
  const row = result.rows[0];
  return row ? {
    sourceType: source.sourceType,
    sourcePublicId: row.public_id,
    sourceHash: hashValue(JSON.stringify(parseJson(row.profile))),
    contextAssetVersionId: null,
    reportVersionId: null,
    personaId: row.id,
  } : null;
}

export async function createAgentEvalSuite(
  viewer: Viewer,
  input: z.infer<typeof agentEvalSuiteInputSchema>,
) {
  if (!isAdmin(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const seenCaseKeys = new Set<string>();
    for (const item of input.cases) {
      if (seenCaseKeys.has(item.caseKey)) return "duplicate_case_key" as const;
      seenCaseKeys.add(item.caseKey);
      const sourceKeys = new Set<string>();
      for (const source of item.sources) {
        const sourceKey = `${source.sourceType}:${source.sourcePublicId}`;
        if (sourceKeys.has(sourceKey)) return "duplicate_source" as const;
        sourceKeys.add(sourceKey);
        if (!await resolveAuthorizedSource(transaction, viewer.workspaceId, source)) return "source_not_authorized" as const;
      }
      const declared = new Set(item.sources.map((source) => source.sourcePublicId));
      if (item.expected.requiredCitationSourcePublicIds.some((publicId) => !declared.has(publicId))) {
        return "expected_source_not_declared" as const;
      }
    }
    const version = await transaction.query<{ value: number }>(
      `select coalesce(max(version), 0)::int + 1 as value
       from agent_eval_suites where workspace_id = $1 and suite_key = $2`,
      [viewer.workspaceId, input.suiteKey],
    );
    const suite = await transaction.query<{ id: string; public_id: string; version: number }>(
      `insert into agent_eval_suites (
         public_id, workspace_id, created_by, suite_key, version, name, description, status
       ) values ($1, $2, $3, $4, $5, $6, $7, 'active')
       returning id::text as id, public_id, version`,
      [createPublicId("aes"), viewer.workspaceId, viewer.userId, input.suiteKey, version.rows[0].value, input.name, input.description],
    );
    for (const item of input.cases) {
      const evaluationCase = await transaction.query<{ id: string; public_id: string }>(
        `insert into agent_eval_cases (
           public_id, suite_id, case_key, title, trust_dimension, instruction, expected
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
         returning id::text as id, public_id`,
        [
          createPublicId("aec"), suite.rows[0].id, item.caseKey, item.title,
          item.trustDimension, item.instruction, JSON.stringify(item.expected),
        ],
      );
      for (const source of item.sources) {
        const authorized = await resolveAuthorizedSource(transaction, viewer.workspaceId, source);
        if (!authorized) throw new Error("AGENT_EVAL_SOURCE_AUTHORIZATION_CHANGED");
        await transaction.query(
          `insert into agent_eval_case_sources (
             evaluation_case_id, source_type, context_asset_version_id, report_version_id,
             persona_id, source_public_id, source_hash
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            evaluationCase.rows[0].id, authorized.sourceType, authorized.contextAssetVersionId,
            authorized.reportVersionId, authorized.personaId, authorized.sourcePublicId, authorized.sourceHash,
          ],
        );
      }
    }
    return { publicId: suite.rows[0].public_id, version: suite.rows[0].version, caseCount: input.cases.length };
  });
}

type StoredCase = {
  id: string;
  publicId: string;
  trustDimension: AgentEvalTrustDimension;
  expected: { requiredCitationSourcePublicIds?: string[]; minimumDistinctPersonaSources?: number };
  sources: Array<{ sourceType: AgentEvalSourceType; sourcePublicId: string; sourceHash: string }>;
};

async function loadSuiteCases(database: Queryable, workspaceId: string, suitePublicId: string) {
  const suite = await database.query<{ id: string; public_id: string; suite_key: string; version: number }>(
    `select id::text as id, public_id, suite_key, version
     from agent_eval_suites where public_id = $1 and workspace_id = $2 and status = 'active'`,
    [suitePublicId, workspaceId],
  );
  const suiteRow = suite.rows[0];
  if (!suiteRow) return null;
  const cases = await database.query<{
    id: string; public_id: string; trust_dimension: AgentEvalTrustDimension;
    expected: StoredCase["expected"] | string; source_type: AgentEvalSourceType | null;
    source_public_id: string | null; source_hash: string | null;
  }>(
    `select evaluation_case.id::text as id, evaluation_case.public_id, evaluation_case.trust_dimension,
            evaluation_case.expected, source.source_type, source.source_public_id, source.source_hash
     from agent_eval_cases evaluation_case
     left join agent_eval_case_sources source on source.evaluation_case_id = evaluation_case.id
     where evaluation_case.suite_id = $1
     order by evaluation_case.id, source.id`,
    [suiteRow.id],
  );
  const byId = new Map<string, StoredCase>();
  for (const row of cases.rows) {
    const stored = byId.get(row.id) ?? {
      id: row.id,
      publicId: row.public_id,
      trustDimension: row.trust_dimension,
      expected: parseJson(row.expected),
      sources: [],
    };
    if (row.source_type && row.source_public_id && row.source_hash) {
      stored.sources.push({ sourceType: row.source_type, sourcePublicId: row.source_public_id, sourceHash: row.source_hash });
    }
    byId.set(row.id, stored);
  }
  return { suite: suiteRow, cases: [...byId.values()] };
}

function judgeCase(caseItem: StoredCase, output: z.infer<typeof agentEvalRunInputSchema>["outputs"][number]) {
  const reasons: string[] = [];
  const permitted = new Set(caseItem.sources.map((source) => source.sourcePublicId));
  const cited = [...new Set(output.citedSourcePublicIds)];
  const personas = [...new Set(output.personaSourcePublicIds)];
  const invalidCitations = cited.filter((publicId) => !permitted.has(publicId));
  const invalidPersonas = personas.filter((publicId) => !permitted.has(publicId));
  if (invalidCitations.length) reasons.push(`unauthorized_citations:${invalidCitations.join(",")}`);
  if (invalidPersonas.length) reasons.push(`unauthorized_personas:${invalidPersonas.join(",")}`);
  if (caseItem.trustDimension === "fabricated_citation") {
    if (!cited.length) reasons.push("citation_missing");
    const required = caseItem.expected.requiredCitationSourcePublicIds ?? [];
    const missing = required.filter((publicId) => !cited.includes(publicId));
    if (missing.length) reasons.push(`required_citations_missing:${missing.join(",")}`);
  }
  if (caseItem.trustDimension === "persona_convergence") {
    const authorizedPersonaIds = new Set(caseItem.sources
      .filter((source) => source.sourceType === "persona")
      .map((source) => source.sourcePublicId));
    const distinct = personas.filter((publicId) => authorizedPersonaIds.has(publicId));
    const minimum = caseItem.expected.minimumDistinctPersonaSources ?? 2;
    if (distinct.length < minimum) reasons.push(`persona_source_count:${distinct.length}/${minimum}`);
  }
  return {
    judgeResult: reasons.length ? "fail" as const : "pass" as const,
    reasons,
  };
}

export async function runAgentEvalSuite(
  viewer: Viewer,
  suitePublicId: string,
  input: z.infer<typeof agentEvalRunInputSchema>,
) {
  if (!isAdmin(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const loaded = await loadSuiteCases(transaction, viewer.workspaceId, suitePublicId);
    if (!loaded) return "not_found" as const;
    const outputByCase = new Map(input.outputs.map((output) => [output.casePublicId, output]));
    if (outputByCase.size !== input.outputs.length) return "duplicate_case_output" as const;
    if (loaded.cases.some((item) => !outputByCase.has(item.publicId)) || outputByCase.size !== loaded.cases.length) {
      return "case_output_mismatch" as const;
    }
    const run = await transaction.query<{ id: string; public_id: string }>(
      `insert into agent_eval_runs (public_id, workspace_id, suite_id, created_by, evaluator_version)
       values ($1, $2, $3, $4, 'deterministic-trust-v1')
       returning id::text as id, public_id`,
      [createPublicId("aer"), viewer.workspaceId, loaded.suite.id, viewer.userId],
    );
    let passed = 0;
    let failed = 0;
    for (const caseItem of loaded.cases) {
      const output = outputByCase.get(caseItem.publicId)!;
      const judged = judgeCase(caseItem, output);
      if (judged.judgeResult === "pass") passed += 1;
      else failed += 1;
      await transaction.query(
        `insert into agent_eval_results (
           evaluation_run_id, evaluation_case_id, candidate_output, judge_result, judge_reasons, source_snapshot
         ) values ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)`,
        [run.rows[0].id, caseItem.id, JSON.stringify(output), judged.judgeResult,
          JSON.stringify(judged.reasons), JSON.stringify(caseItem.sources)],
      );
    }
    await transaction.query(
      `update agent_eval_runs set status = 'completed', case_count = $2, passed_count = $3,
              failed_count = $4, needs_review_count = 0, finished_at = now() where id = $1`,
      [run.rows[0].id, loaded.cases.length, passed, failed],
    );
    return { publicId: run.rows[0].public_id, caseCount: loaded.cases.length, passedCount: passed, failedCount: failed };
  });
}

export async function labelAgentEvalCase(
  viewer: Viewer,
  suitePublicId: string,
  input: z.infer<typeof agentEvalLabelInputSchema>,
) {
  if (!isAdmin(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{ id: string }>(
    `select evaluation_case.id::text as id
     from agent_eval_cases evaluation_case
     join agent_eval_suites suite on suite.id = evaluation_case.suite_id
     where suite.public_id = $1 and suite.workspace_id = $2 and evaluation_case.public_id = $3`,
    [suitePublicId, viewer.workspaceId, input.casePublicId],
  );
  const row = result.rows[0];
  if (!row) return "not_found" as const;
  const label = await database.query<{ public_id: string }>(
    `insert into agent_eval_case_labels (public_id, evaluation_case_id, workspace_id, labeled_by, label, note)
     values ($1, $2, $3, $4, $5, $6) returning public_id`,
    [createPublicId("ael"), row.id, viewer.workspaceId, viewer.userId, input.label, input.note],
  );
  return { publicId: label.rows[0].public_id };
}

export async function listAgentEvalSuites(viewer: Viewer) {
  const database = await getDatabase();
  const result = await database.query<{
    suite_public_id: string; suite_key: string; version: number; name: string; description: string; status: string;
    case_count: number; dimensions: AgentEvalTrustDimension[] | string; run_public_id: string | null;
    run_status: string | null; passed_count: number | null; failed_count: number | null;
    needs_review_count: number | null; started_at: string | null; finished_at: string | null;
  }>(
    `select suite.public_id as suite_public_id, suite.suite_key, suite.version, suite.name, suite.description,
            suite.status, count(distinct evaluation_case.id)::int as case_count,
            coalesce(array_agg(distinct evaluation_case.trust_dimension) filter (where evaluation_case.id is not null), '{}') as dimensions,
            recent_run.public_id as run_public_id, recent_run.status as run_status,
            recent_run.passed_count, recent_run.failed_count, recent_run.needs_review_count,
            recent_run.started_at::text as started_at, recent_run.finished_at::text as finished_at
     from agent_eval_suites suite
     left join agent_eval_cases evaluation_case on evaluation_case.suite_id = suite.id
     left join lateral (
       select public_id, status, passed_count, failed_count, needs_review_count, started_at, finished_at
       from agent_eval_runs run where run.suite_id = suite.id order by started_at desc, id desc limit 1
     ) recent_run on true
     where suite.workspace_id = $1
     group by suite.id, recent_run.public_id, recent_run.status, recent_run.passed_count,
              recent_run.failed_count, recent_run.needs_review_count, recent_run.started_at, recent_run.finished_at
     order by suite.created_at desc, suite.id desc
     limit 50`,
    [viewer.workspaceId],
  );
  return result.rows.map((row) => ({
    publicId: row.suite_public_id,
    suiteKey: row.suite_key,
    version: row.version,
    name: row.name,
    description: row.description,
    status: row.status,
    caseCount: row.case_count,
    trustDimensions: typeof row.dimensions === "string" ? JSON.parse(row.dimensions) as AgentEvalTrustDimension[] : row.dimensions,
    latestRun: row.run_public_id ? {
      publicId: row.run_public_id,
      status: row.run_status,
      passedCount: row.passed_count ?? 0,
      failedCount: row.failed_count ?? 0,
      needsReviewCount: row.needs_review_count ?? 0,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    } : null,
  }));
}
