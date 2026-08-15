import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase, type Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export type PersonaEvidenceStatus = "ungrounded" | "synthetic_grounded" | "human_grounded" | "mixed_grounded" | "context_grounded" | "unsupported";
export type PersonaEvidenceConfidence = "low" | "medium" | "high";
export type PersonaRetentionStatus = "pending" | "retained" | "retired" | "expired";

export type PersonaGroundingSummary = {
  claimCount: number;
  evidenceCount: number;
  humanEvidenceCount: number;
  syntheticEvidenceCount: number;
  factualEvidenceCount: number;
  supportedClaimCount: number;
};

export type PersonaEvidenceDetail = {
  publicId: string;
  name: string;
  evidenceStatus: PersonaEvidenceStatus;
  evidenceConfidence: PersonaEvidenceConfidence;
  groundingSummary: PersonaGroundingSummary;
  groundedAt: string | null;
  retentionStatus: PersonaRetentionStatus;
  validUntil: string | null;
  retentionNote: string | null;
  retentionReviewedAt: string | null;
  reviewerName: string | null;
  canGovern: boolean;
  evidence: Array<{
    publicId: string;
    title: string;
    sourceType: string;
    evidenceType: string;
    content: string;
    sourceUri: string | null;
    locator: Record<string, unknown>;
    relation: string;
    profilePath: string;
    rationale: string;
    claims: Array<{
      publicId: string;
      statement: string;
      claimType: string;
      confidence: string;
      supportStatus: string;
      stance: string;
      strength: string;
    }>;
  }>;
  events: Array<{
    publicId: string;
    eventType: string;
    payload: Record<string, unknown>;
    actorName: string | null;
    createdAt: string;
  }>;
};

const emptyGroundingSummary: PersonaGroundingSummary = {
  claimCount: 0,
  evidenceCount: 0,
  humanEvidenceCount: 0,
  syntheticEvidenceCount: 0,
  factualEvidenceCount: 0,
  supportedClaimCount: 0,
};

export const personaRetentionInputSchema = z.object({
  retentionStatus: z.enum(["retained", "retired"]),
  validUntil: z.string().datetime({ offset: true }).nullable().default(null),
  note: z.string().trim().max(1000).default(""),
}).superRefine((input, context) => {
  if (input.retentionStatus === "retired" && input.note.length < 2) {
    context.addIssue({ code: "custom", path: ["note"], message: "退役 Persona 时请填写原因" });
  }
});

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function effectiveRetentionStatus(status: Exclude<PersonaRetentionStatus, "expired">, validUntil: string | null): PersonaRetentionStatus {
  return status === "retained" && validUntil && new Date(validUntil).getTime() <= Date.now() ? "expired" : status;
}

function normalizeGroundingSummary(value: unknown): PersonaGroundingSummary {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const summary = parsed && typeof parsed === "object" ? parsed as Partial<PersonaGroundingSummary> : {};
  return {
    claimCount: Number(summary.claimCount ?? 0),
    evidenceCount: Number(summary.evidenceCount ?? 0),
    humanEvidenceCount: Number(summary.humanEvidenceCount ?? 0),
    syntheticEvidenceCount: Number(summary.syntheticEvidenceCount ?? 0),
    factualEvidenceCount: Number(summary.factualEvidenceCount ?? 0),
    supportedClaimCount: Number(summary.supportedClaimCount ?? 0),
  };
}

async function appendPersonaGovernanceEvent(queryable: Queryable, input: {
  workspaceId: string;
  personaId: string;
  actorUserId: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  await queryable.query(
    `insert into persona_governance_events (
       public_id, workspace_id, persona_id, actor_user_id, event_type, payload
     ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      createPublicId("pge"), input.workspaceId, input.personaId, input.actorUserId,
      input.eventType, JSON.stringify(input.payload ?? {}),
    ],
  );
}

export async function groundStudyPersonasFromEvidence(queryable: Queryable, input: {
  workspaceId: string;
  studyId: string;
  runId: string | null;
  personas: Array<{ publicId: string; name: string }>;
}) {
  if (!input.personas.length) return { grounded: 0, unsupported: 0, links: 0 };
  const publicIds = input.personas.map((persona) => persona.publicId);
  const managed = await queryable.query<{ id: string }>(
    `select id::text as id from study_personas
     where workspace_id = $1 and study_id = $2 and run_id is not distinct from $3
       and public_id = any($4::text[])`,
    [input.workspaceId, input.studyId, input.runId, publicIds],
  );
  if (!managed.rows.length) return { grounded: 0, unsupported: 0, links: 0 };
  const personaIds = managed.rows.map((persona) => persona.id);
  await queryable.query(
    `delete from persona_evidence_links
     where persona_id = any($1::bigint[]) and link_source = 'automatic'`,
    [personaIds],
  );
  const inserted = await queryable.query<{ id: string }>(
    `insert into persona_evidence_links (
       workspace_id, persona_id, evidence_item_id, relation, profile_path, rationale, link_source
     )
     select distinct $1::bigint, persona.id, item.id, 'context', '$',
            '同一研究 Run 的证据 locator 精确匹配该 Persona', 'automatic'
     from study_personas persona
     join evidence_sources source on source.study_id = $2 and source.run_id is not distinct from $3
     join evidence_items item on item.source_id = source.id
     where persona.id = any($4::bigint[])
       and (
         item.locator->>'personaPublicId' = persona.public_id
         or item.locator->>'personaName' = persona.name
       )
     on conflict (persona_id, evidence_item_id, profile_path) do update set
       relation = excluded.relation, rationale = excluded.rationale, link_source = excluded.link_source
     returning id::text as id`,
    [input.workspaceId, input.studyId, input.runId, personaIds],
  );
  const summaries = await queryable.query<{
    id: string;
    public_id: string;
    evidence_count: number;
    human_count: number;
    synthetic_count: number;
    factual_count: number;
    claim_count: number;
    supported_claim_count: number;
  }>(
    `select persona.id::text as id, persona.public_id,
            count(distinct item.id)::int as evidence_count,
            count(distinct item.id) filter (where item.evidence_type = 'human_observation')::int as human_count,
            count(distinct item.id) filter (where item.evidence_type = 'synthetic_simulation')::int as synthetic_count,
            count(distinct item.id) filter (where item.evidence_type in ('fact', 'calculation'))::int as factual_count,
            count(distinct claim.id)::int as claim_count,
            count(distinct claim.id) filter (where claim.support_status = 'supported')::int as supported_claim_count
     from study_personas persona
     left join persona_evidence_links link on link.persona_id = persona.id
     left join evidence_items item on item.id = link.evidence_item_id
     left join claim_evidence claim_link on claim_link.evidence_item_id = item.id
     left join claims claim on claim.id = claim_link.claim_id
     where persona.id = any($1::bigint[])
     group by persona.id`,
    [personaIds],
  );
  let grounded = 0;
  let unsupported = 0;
  for (const row of summaries.rows) {
    const evidenceStatus: PersonaEvidenceStatus = row.evidence_count === 0
      ? "unsupported"
      : row.human_count > 0 && row.synthetic_count > 0
        ? "mixed_grounded"
        : row.human_count > 0
          ? "human_grounded"
          : row.synthetic_count > 0
            ? "synthetic_grounded"
            : "context_grounded";
    const confidence: PersonaEvidenceConfidence = row.human_count >= 2 && row.supported_claim_count >= 2
      ? "high"
      : row.evidence_count >= 2 && row.claim_count >= 1
        ? "medium"
        : "low";
    const summary: PersonaGroundingSummary = {
      claimCount: row.claim_count,
      evidenceCount: row.evidence_count,
      humanEvidenceCount: row.human_count,
      syntheticEvidenceCount: row.synthetic_count,
      factualEvidenceCount: row.factual_count,
      supportedClaimCount: row.supported_claim_count,
    };
    const changed = await queryable.query<{ id: string }>(
      `update study_personas set evidence_status = $2, evidence_confidence = $3,
              grounding_summary = $4::jsonb, grounded_at = now(), updated_at = now()
       where id = $1 and (
         evidence_status is distinct from $2 or evidence_confidence is distinct from $3
         or grounding_summary is distinct from $4::jsonb
       ) returning id::text as id`,
      [row.id, evidenceStatus, confidence, JSON.stringify(summary)],
    );
    if (changed.rows[0]) {
      await appendPersonaGovernanceEvent(queryable, {
        workspaceId: input.workspaceId,
        personaId: row.id,
        actorUserId: null,
        eventType: evidenceStatus === "unsupported" ? "evidence.unsupported" : "evidence.grounded",
        payload: { evidenceStatus, confidence, summary, studyId: input.studyId, runId: input.runId },
      });
    }
    if (evidenceStatus === "unsupported") unsupported += 1;
    else grounded += 1;
  }
  return { grounded, unsupported, links: inserted.rowCount ?? inserted.rows.length };
}

export async function getPersonaEvidence(viewer: Viewer, publicId: string): Promise<PersonaEvidenceDetail | "not_found"> {
  const database = await getDatabase();
  const persona = await database.query<{
    id: string;
    public_id: string;
    name: string;
    created_by: string;
    visibility: "private" | "workspace";
    evidence_status: PersonaEvidenceStatus;
    evidence_confidence: PersonaEvidenceConfidence;
    grounding_summary: PersonaGroundingSummary | string;
    grounded_at: string | null;
    retention_status: Exclude<PersonaRetentionStatus, "expired">;
    valid_until: string | null;
    retention_note: string | null;
    retention_reviewed_at: string | null;
    reviewer_name: string | null;
  }>(
    `select persona.id::text as id, persona.public_id, persona.name,
            persona.created_by::text as created_by, persona.visibility,
            persona.evidence_status, persona.evidence_confidence, persona.grounding_summary,
            persona.grounded_at::text as grounded_at, persona.retention_status,
            persona.valid_until::text as valid_until, persona.retention_note,
            persona.retention_reviewed_at::text as retention_reviewed_at,
            reviewer.display_name as reviewer_name
     from study_personas persona
     left join users reviewer on reviewer.id = persona.retention_reviewed_by
     where persona.public_id = $1 and persona.workspace_id = $2
       and (persona.visibility = 'workspace' or persona.created_by = $3)
     limit 1`,
    [publicId, viewer.workspaceId, viewer.userId],
  );
  const row = persona.rows[0];
  if (!row) return "not_found";
  const [evidenceResult, eventsResult] = await Promise.all([
    database.query<{
      public_id: string;
      title: string;
      source_type: string;
      evidence_type: string;
      content: string;
      source_uri: string | null;
      locator: Record<string, unknown> | string;
      relation: string;
      profile_path: string;
      rationale: string;
      claims: PersonaEvidenceDetail["evidence"][number]["claims"] | string;
    }>(
      `select item.public_id, source.title, source.source_type, item.evidence_type,
              left(item.content, 2000) as content, source.source_uri, item.locator,
              link.relation, link.profile_path, link.rationale,
              coalesce(jsonb_agg(distinct jsonb_build_object(
                'publicId', claim.public_id, 'statement', claim.statement,
                'claimType', claim.claim_type, 'confidence', claim.confidence,
                'supportStatus', claim.support_status, 'stance', claim_link.stance,
                'strength', claim_link.strength
              )) filter (where claim.id is not null), '[]'::jsonb) as claims
       from persona_evidence_links link
       join evidence_items item on item.id = link.evidence_item_id
       join evidence_sources source on source.id = item.source_id
       left join claim_evidence claim_link on claim_link.evidence_item_id = item.id
       left join claims claim on claim.id = claim_link.claim_id
       where link.persona_id = $1
       group by link.id, item.id, source.id
       order by link.created_at desc, item.id desc`,
      [row.id],
    ),
    database.query<{
      public_id: string;
      event_type: string;
      payload: Record<string, unknown> | string;
      actor_name: string | null;
      created_at: string;
    }>(
      `select event.public_id, event.event_type, event.payload,
              actor.display_name as actor_name, event.created_at::text as created_at
       from persona_governance_events event
       left join users actor on actor.id = event.actor_user_id
       where event.persona_id = $1 order by event.created_at desc limit 20`,
      [row.id],
    ),
  ]);
  return {
    publicId: row.public_id,
    name: row.name,
    evidenceStatus: row.evidence_status,
    evidenceConfidence: row.evidence_confidence,
    groundingSummary: normalizeGroundingSummary(parseJson(row.grounding_summary)),
    groundedAt: row.grounded_at,
    retentionStatus: effectiveRetentionStatus(row.retention_status, row.valid_until),
    validUntil: row.valid_until,
    retentionNote: row.retention_note,
    retentionReviewedAt: row.retention_reviewed_at,
    reviewerName: row.reviewer_name,
    canGovern: row.created_by === viewer.userId || viewer.role === "owner" || viewer.role === "admin",
    evidence: evidenceResult.rows.map((evidence) => ({
      publicId: evidence.public_id,
      title: evidence.title,
      sourceType: evidence.source_type,
      evidenceType: evidence.evidence_type,
      content: evidence.content,
      sourceUri: evidence.source_uri,
      locator: parseJson(evidence.locator),
      relation: evidence.relation,
      profilePath: evidence.profile_path,
      rationale: evidence.rationale,
      claims: parseJson(evidence.claims),
    })),
    events: eventsResult.rows.map((event) => ({
      publicId: event.public_id,
      eventType: event.event_type,
      payload: parseJson(event.payload),
      actorName: event.actor_name,
      createdAt: event.created_at,
    })),
  };
}

export async function updatePersonaRetention(
  viewer: Viewer,
  publicId: string,
  input: z.infer<typeof personaRetentionInputSchema>,
) {
  if (input.retentionStatus === "retained" && input.validUntil && new Date(input.validUntil).getTime() <= Date.now()) {
    return "invalid_expiry" as const;
  }
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      id: string;
      created_by: string;
      retention_status: string;
      valid_until: string | null;
    }>(
      `select id::text as id, created_by::text as created_by, retention_status,
              valid_until::text as valid_until
       from study_personas where public_id = $1 and workspace_id = $2 for update`,
      [publicId, viewer.workspaceId],
    );
    const persona = result.rows[0];
    if (!persona) return "not_found" as const;
    if (persona.created_by !== viewer.userId && viewer.role !== "owner" && viewer.role !== "admin") {
      return "forbidden" as const;
    }
    await transaction.query(
      `update study_personas set retention_status = $2, valid_until = $3,
              retention_reviewed_by = $4, retention_reviewed_at = now(),
              retention_note = $5, updated_at = now() where id = $1`,
      [persona.id, input.retentionStatus, input.validUntil, viewer.userId, input.note],
    );
    await appendPersonaGovernanceEvent(transaction, {
      workspaceId: viewer.workspaceId,
      personaId: persona.id,
      actorUserId: viewer.userId,
      eventType: input.retentionStatus === "retained" ? "retention.retained" : "retention.retired",
      payload: {
        previousStatus: persona.retention_status,
        previousValidUntil: persona.valid_until,
        retentionStatus: input.retentionStatus,
        validUntil: input.validUntil,
        note: input.note,
      },
    });
    return {
      publicId,
      retentionStatus: input.retentionStatus,
      validUntil: input.validUntil,
    };
  });
}

export { emptyGroundingSummary, effectiveRetentionStatus, normalizeGroundingSummary };
