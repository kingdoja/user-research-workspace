import type { Queryable } from "../src/lib/db";
import { createConfirmedPlanVersion } from "../src/lib/study-plan-versions";

export async function createSmokePlanVersion(queryable: Queryable, studyId: string, userId: string) {
  await queryable.query(
    `insert into study_plans (
       study_id, framework, methods, persona_filters, persona_count,
       estimated_duration_minutes, estimated_tokens, source, prompt_version, rationale
     ) values ($1, 'Smoke Framework', '["Scout Agent"]'::jsonb,
               '{"audience":"Smoke audience","source":"fixture"}'::jsonb,
               1, 10, 1000, 'local_rules', 'smoke-plan-v1', 'Smoke fixture plan')`,
    [studyId],
  );
  return createConfirmedPlanVersion(queryable, studyId, userId);
}
