import type { Queryable } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export type LockedPlanVersion = {
  id: string;
  publicId: string;
  version: number;
  schemaVersion: string;
  contentHash: string;
};

export async function createConfirmedPlanVersion(
  queryable: Queryable,
  studyId: string,
  confirmedBy: string,
  intentVersionId: string | null = null,
): Promise<LockedPlanVersion> {
  const result = await queryable.query<{
    id: string;
    public_id: string;
    version: number;
    schema_version: string;
    content_hash: string;
  }>(
    `insert into study_plan_versions (
       public_id, workspace_id, study_id, intent_version_id, version, lifecycle_status, snapshot_reason,
       product_line, brief_snapshot, study_type, framework, methods, persona_filters, persona_count,
       estimated_duration_minutes, estimated_tokens, source, provider_response_id,
       provider_model, prompt_version, rationale, gpt_researcher_report_type, content_hash, confirmed_by, confirmed_at
     )
     select $2, study.workspace_id, study.id, $4, plan.version, 'confirmed', 'confirmation',
            study.product_line, study.brief, study.study_type, plan.framework, plan.methods, plan.persona_filters,
            plan.persona_count, plan.estimated_duration_minutes, plan.estimated_tokens,
            plan.source, plan.provider_response_id, plan.provider_model, plan.prompt_version,
            plan.rationale, plan.gpt_researcher_report_type,
            encode(digest(jsonb_build_object(
              'schemaVersion', 'research-plan-v1',
              'productLine', study.product_line,
              'brief', study.brief,
              'studyType', study.study_type,
              'framework', plan.framework,
              'methods', plan.methods,
              'personaFilters', plan.persona_filters,
              'personaCount', plan.persona_count,
              'estimatedDurationMinutes', plan.estimated_duration_minutes,
              'estimatedTokens', plan.estimated_tokens,
              'source', plan.source,
              'providerResponseId', plan.provider_response_id,
              'providerModel', plan.provider_model,
              'promptVersion', plan.prompt_version,
              'rationale', plan.rationale,
              'gptResearcherReportType', plan.gpt_researcher_report_type
            )::text, 'sha256'), 'hex'),
            $3, now()
     from studies study
     join study_plans plan on plan.study_id = study.id
     where study.id = $1
     returning id::text as id, public_id, version, schema_version, content_hash`,
    [studyId, createPublicId("plv"), confirmedBy, intentVersionId],
  );
  const version = result.rows[0];
  if (!version) throw new Error("PLAN_VERSION_CREATE_FAILED");

  await queryable.query(
    `update study_plans
     set current_plan_version_id = $2, status = 'confirmed', confirmed_at = now(), updated_at = now()
     where study_id = $1`,
    [studyId, version.id],
  );

  return {
    id: version.id,
    publicId: version.public_id,
    version: version.version,
    schemaVersion: version.schema_version,
    contentHash: version.content_hash,
  };
}
