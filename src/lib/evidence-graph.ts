import { createHash } from "node:crypto";
import type { Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import type { ResearchCitation, ResearchReport } from "@/lib/openai-provider";
import type { ReportEvidenceCatalogItem } from "@/lib/report-evidence";

export type ReportEvidenceGraph = {
  versionPublicId: string;
  version: number;
  status: string;
  nodes: Array<{
    publicId: string;
    nodeKey: string;
    nodeType: string;
    position: number;
    title: string;
    body: string;
    payload: Record<string, unknown>;
    claim: null | {
      publicId: string;
      statement: string;
      claimType: string;
      confidence: string;
      supportStatus: string;
      rationale: string;
      evidence: Array<{
        publicId: string;
        ref: string;
        title: string;
        sourceType: string;
        evidenceType: string;
        content: string;
        sourceUri: string | null;
        locator: Record<string, unknown>;
        stance: string;
        strength: string;
      }>;
    };
  }>;
};

function hashEvidence(item: ReportEvidenceCatalogItem) {
  return createHash("sha256").update(JSON.stringify({
    type: item.sourceType,
    title: item.title,
    uri: item.sourceUri,
    content: item.content,
  })).digest("hex");
}

export async function materializeReportEvidenceGraph(queryable: Queryable, input: {
  workspaceId: string;
  studyId: string;
  runId: string | null;
  reportId: string;
  report: ResearchReport;
  citations: ResearchCitation[];
  catalog: ReportEvidenceCatalogItem[];
  provider: string | null;
  providerModel: string | null;
  providerResponseId: string | null;
  promptVersion: string | null;
}) {
  const existing = input.runId ? await queryable.query<{ id: string; public_id: string; version: number }>(
    `select id::text as id, public_id, version from report_versions
     where report_id = $1 and run_id = $2 limit 1`,
    [input.reportId, input.runId],
  ) : { rows: [] };
  if (existing.rows[0]) return existing.rows[0];

  const catalogByRef = new Map(input.catalog.map((item) => [item.ref, item]));
  const evidenceIds = new Map<string, string>();
  for (const item of input.catalog) {
    const source = await queryable.query<{ id: string }>(
      `insert into evidence_sources (
         public_id, workspace_id, study_id, run_id, source_type, title, source_uri,
         source_locator, content_hash, metadata, collected_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, now())
       on conflict (study_id, run_id, source_type, content_hash) do update set title = excluded.title
       returning id::text as id`,
      [
        createPublicId("evs"), input.workspaceId, input.studyId, input.runId, item.sourceType,
        item.title, item.sourceUri, JSON.stringify(item.locator), hashEvidence(item), JSON.stringify(item.metadata),
      ],
    );
    const evidence = await queryable.query<{ id: string }>(
      `insert into evidence_items (
         public_id, source_id, item_key, evidence_type, content, locator, metadata
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       on conflict (source_id, item_key) do update set content = excluded.content
       returning id::text as id`,
      [createPublicId("evi"), source.rows[0].id, item.ref, item.evidenceType, item.content, JSON.stringify(item.locator), JSON.stringify(item.metadata)],
    );
    evidenceIds.set(item.ref, evidence.rows[0].id);
  }

  const versionNumber = await queryable.query<{ value: number }>(
    "select coalesce(max(version), 0)::int + 1 as value from report_versions where report_id = $1",
    [input.reportId],
  );
  const version = await queryable.query<{ id: string; public_id: string; version: number }>(
    `insert into report_versions (
       public_id, report_id, study_id, run_id, version, content_json, provider,
       provider_model, provider_response_id, prompt_version
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     returning id::text as id, public_id, version`,
    [
      createPublicId("rpv"), input.reportId, input.studyId, input.runId,
      versionNumber.rows[0].value, JSON.stringify({ ...input.report, citations: input.citations }),
      input.provider, input.providerModel, input.providerResponseId, input.promptVersion,
    ],
  );

  let position = 0;
  await queryable.query(
    `insert into report_nodes (public_id, report_version_id, node_key, node_type, position, title, body)
     values ($1, $2, 'summary', 'summary', $3, $4, $5)`,
    [createPublicId("rpn"), version.rows[0].id, position++, input.report.title, input.report.executiveSummary],
  );
  for (const [index, finding] of input.report.findings.entries()) {
    const refs = finding.evidenceRefs.filter((ref) => catalogByRef.has(ref));
    const claim = await queryable.query<{ id: string }>(
      `insert into claims (
         public_id, workspace_id, study_id, run_id, claim_key, statement, claim_type,
         confidence, support_status, rationale
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (study_id, run_id, claim_key) do update set
         statement = excluded.statement, claim_type = excluded.claim_type,
         confidence = excluded.confidence, support_status = excluded.support_status,
         rationale = excluded.rationale, updated_at = now()
       returning id::text as id`,
      [
        createPublicId("clm"), input.workspaceId, input.studyId, input.runId, `finding-${index + 1}`,
        finding.insight, finding.claimType, finding.confidence,
        refs.length ? "supported" : "unsupported", finding.evidence,
      ],
    );
    for (const ref of refs) {
      const evidenceId = evidenceIds.get(ref);
      if (!evidenceId) continue;
      await queryable.query(
        `insert into claim_evidence (claim_id, evidence_item_id, stance, strength, rationale)
         values ($1, $2, 'supports', $3, $4)
         on conflict (claim_id, evidence_item_id) do nothing`,
        [claim.rows[0].id, evidenceId, finding.confidence, `报告 finding 引用 ${ref}`],
      );
    }
    await queryable.query(
      `insert into report_nodes (
         public_id, report_version_id, claim_id, node_key, node_type, position, title, body, payload
       ) values ($1, $2, $3, $4, 'finding', $5, $6, $7, $8::jsonb)`,
      [
        createPublicId("rpn"), version.rows[0].id, claim.rows[0].id, `finding-${index + 1}`,
        position++, finding.title, finding.insight,
        JSON.stringify({ evidence: finding.evidence, implication: finding.implication, evidenceRefs: refs }),
      ],
    );
  }
  for (const [index, recommendation] of input.report.recommendations.entries()) {
    await queryable.query(
      `insert into report_nodes (public_id, report_version_id, node_key, node_type, position, title, body, payload)
       values ($1, $2, $3, 'recommendation', $4, $5, $6, $7::jsonb)`,
      [createPublicId("rpn"), version.rows[0].id, `recommendation-${index + 1}`, position++, recommendation.title, recommendation.action, JSON.stringify({ rationale: recommendation.rationale, priority: recommendation.priority })],
    );
  }
  for (const [index, limitation] of input.report.limitations.entries()) {
    await queryable.query(
      `insert into report_nodes (public_id, report_version_id, node_key, node_type, position, body)
       values ($1, $2, $3, 'limitation', $4, $5)`,
      [createPublicId("rpn"), version.rows[0].id, `limitation-${index + 1}`, position++, limitation],
    );
  }
  for (const [index, question] of input.report.nextQuestions.entries()) {
    await queryable.query(
      `insert into report_nodes (public_id, report_version_id, node_key, node_type, position, body)
       values ($1, $2, $3, 'next_question', $4, $5)`,
      [createPublicId("rpn"), version.rows[0].id, `next-question-${index + 1}`, position++, question],
    );
  }
  await queryable.query("update reports set current_version_id = $2 where id = $1", [input.reportId, version.rows[0].id]);
  return version.rows[0];
}

export async function getReportEvidenceGraph(queryable: Queryable, reportId: string): Promise<ReportEvidenceGraph | null> {
  const version = await queryable.query<{ id: string; public_id: string; version: number; status: string }>(
    `select version.id::text as id, version.public_id, version.version, version.status
     from reports report join report_versions version on version.id = report.current_version_id
     where report.id = $1 limit 1`,
    [reportId],
  );
  if (!version.rows[0]) return null;
  const nodes = await queryable.query<{
    public_id: string; node_key: string; node_type: string; position: number; title: string; body: string;
    payload: Record<string, unknown> | string; claim_public_id: string | null; statement: string | null;
    claim_type: string | null; confidence: string | null; support_status: string | null; rationale: string | null;
    evidence: unknown[] | string;
  }>(
    `select node.public_id, node.node_key, node.node_type, node.position, node.title, node.body, node.payload,
            claim.public_id as claim_public_id, claim.statement, claim.claim_type, claim.confidence,
            claim.support_status, claim.rationale,
            coalesce(jsonb_agg(jsonb_build_object(
              'publicId', item.public_id, 'ref', item.item_key, 'title', source.title,
              'sourceType', source.source_type, 'evidenceType', item.evidence_type,
              'content', item.content, 'sourceUri', source.source_uri, 'locator', item.locator,
              'stance', link.stance, 'strength', link.strength
            ) order by item.id) filter (where item.id is not null), '[]'::jsonb) as evidence
     from report_nodes node
     left join claims claim on claim.id = node.claim_id
     left join claim_evidence link on link.claim_id = claim.id
     left join evidence_items item on item.id = link.evidence_item_id
     left join evidence_sources source on source.id = item.source_id
     where node.report_version_id = $1
     group by node.id, claim.id order by node.position`,
    [version.rows[0].id],
  );
  return {
    versionPublicId: version.rows[0].public_id,
    version: version.rows[0].version,
    status: version.rows[0].status,
    nodes: nodes.rows.map((node) => ({
      publicId: node.public_id,
      nodeKey: node.node_key,
      nodeType: node.node_type,
      position: node.position,
      title: node.title,
      body: node.body,
      payload: typeof node.payload === "string" ? JSON.parse(node.payload) : node.payload,
      claim: node.claim_public_id ? {
        publicId: node.claim_public_id,
        statement: node.statement ?? "",
        claimType: node.claim_type ?? "model_inference",
        confidence: node.confidence ?? "low",
        supportStatus: node.support_status ?? "unsupported",
        rationale: node.rationale ?? "",
        evidence: (typeof node.evidence === "string" ? JSON.parse(node.evidence) : node.evidence) as ReportEvidenceGraph["nodes"][number]["claim"] extends infer Claim ? Claim extends { evidence: infer Evidence } ? Evidence : never : never,
      } : null,
    })),
  };
}

export function sanitizeReportEvidenceGraphForPublic(graph: ReportEvidenceGraph | null) {
  if (!graph) return null;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      claim: node.claim ? {
        ...node.claim,
        evidence: node.claim.evidence.map((evidence) => {
          if (evidence.evidenceType !== "human_observation" && evidence.sourceType !== "interview_session") {
            return evidence;
          }
          return {
            ...evidence,
            content: "真人访谈证据已纳入分析；公开分享不展示参与者原文或内部会话定位信息。",
            sourceUri: null,
            locator: {},
          };
        }),
      } : null,
    })),
  };
}
