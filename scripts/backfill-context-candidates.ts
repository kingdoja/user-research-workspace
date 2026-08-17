import { loadEnvConfig } from "@next/env";
import { closeDatabase, getDatabase } from "../src/lib/db";
import { proposeStudyContextCandidates } from "../src/lib/context-system";

loadEnvConfig(process.cwd());

if (process.env.CONTEXT_CANDIDATE_BACKFILL_CONFIRM !== "1") {
  throw new Error("Set CONTEXT_CANDIDATE_BACKFILL_CONFIRM=1 to backfill governed Context candidates.");
}

function parseJson<Value>(value: Value | string): Value {
  return typeof value === "string" ? JSON.parse(value) as Value : value;
}

async function main() {
  const database = await getDatabase();
  try {
    const reports = await database.query<{
      workspace_id: string; created_by: string; study_id: string; study_public_id: string;
      brief: string; study_type: string; report_public_id: string; report_title: string;
      report_description: string; report_content: Record<string, unknown> | string;
      run_id: string; workflow_type: string; workflow_version: string;
      framework: string; methods: string[] | string; persona_filters: Record<string, unknown> | string;
      persona_count: number; workflow_task_graph: Array<Record<string, unknown>> | string | null;
    }>(
      `select study.workspace_id::text as workspace_id, study.created_by::text as created_by,
              study.id::text as study_id, study.public_id as study_public_id,
              study.brief, study.study_type, report.public_id as report_public_id,
              report.title as report_title, report.description as report_description,
              report.content_json as report_content, run.id::text as run_id,
              run.workflow_type, run.workflow_version,
              plan.framework, plan.methods, plan.persona_filters, plan.persona_count,
              workflow.task_graph as workflow_task_graph
       from reports report
       join studies study on study.id = report.study_id
       join lateral (
         select candidate.* from study_runs candidate
         where candidate.study_id = study.id and candidate.status = 'completed'
         order by candidate.finished_at desc nulls last, candidate.id desc limit 1
       ) run on true
       join study_plan_versions plan on plan.id = run.plan_version_id
       left join workflow_definitions workflow on workflow.id = run.workflow_definition_id
       order by report.id`,
    );

    let proposed = 0;
    let duplicates = 0;
    let templates = 0;
    let gaps = 0;
    for (const row of reports.rows) {
      const storedTasks = await database.query<{
        task_key: string; title: string; tool_name: string; depends_on: string[] | string;
      }>(
        `select task_key, title, tool_name, depends_on from study_tasks
         where run_id = $1 order by position, id`,
        [row.run_id],
      );
      const workflowTasks = row.workflow_task_graph ? parseJson(row.workflow_task_graph) : [];
      const taskGraph = (workflowTasks.length ? workflowTasks : storedTasks.rows).map((task) => ({
        key: String("key" in task ? task.key : task.task_key),
        title: String(task.title),
        toolName: String("toolName" in task ? task.toolName : task.tool_name),
        dependsOn: parseJson(("dependsOn" in task ? task.dependsOn : task.depends_on) ?? []) as string[],
      }));
      const filters = parseJson(row.persona_filters);
      const result = await database.transaction((transaction) => proposeStudyContextCandidates(transaction, {
        workspaceId: row.workspace_id,
        userId: row.created_by,
        studyPublicId: row.study_public_id,
        report: {
          publicId: row.report_public_id,
          title: row.report_title,
          executiveSummary: row.report_description,
          content: parseJson(row.report_content),
        },
        personas: [],
        study: {
          brief: row.brief,
          studyType: row.study_type,
          framework: row.framework,
          methods: parseJson(row.methods),
          audience: typeof filters.audience === "string" ? filters.audience : "由研究 Brief 确定的目标人群",
          personaCount: row.persona_count,
          workflowType: row.workflow_type,
          workflowVersion: row.workflow_version,
          taskGraph,
        },
      }));
      proposed += result.proposed;
      duplicates += result.duplicates;
      templates += 1;
      gaps += result.knowledgeGapAssetPublicIds.length;
    }
    console.log(JSON.stringify({ reports: reports.rows.length, proposed, duplicates, templates, gaps }));
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
