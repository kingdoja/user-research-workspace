alter table public.studies
  add column if not exists product_line text not null default 'research';

alter table public.studies
  drop constraint if exists studies_product_line_check,
  add constraint studies_product_line_check check (product_line in ('research', 'market_insight'));

alter table public.study_intent_versions
  add column if not exists product_line text not null default 'research';

alter table public.study_intent_versions
  drop constraint if exists study_intent_versions_product_line_check,
  add constraint study_intent_versions_product_line_check check (product_line in ('research', 'market_insight'));

alter table public.study_plan_versions
  add column if not exists product_line text not null default 'research';

alter table public.study_plan_versions
  drop constraint if exists study_plan_versions_product_line_check,
  add constraint study_plan_versions_product_line_check check (product_line in ('research', 'market_insight'));

alter table public.workflow_definitions
  drop constraint if exists workflow_definitions_type_check,
  add constraint workflow_definitions_type_check check (workflow_type in ('batch_research', 'market_insight'));

alter table public.study_runs
  drop constraint if exists study_runs_workflow_type_check,
  add constraint study_runs_workflow_type_check check (workflow_type in ('realtime_agent', 'batch_research', 'market_insight'));

alter table public.strategy_experiments
  drop constraint if exists strategy_experiments_workflow_type_check,
  add constraint strategy_experiments_workflow_type_check check (workflow_type in ('realtime_agent', 'batch_research', 'market_insight'));

create index if not exists studies_workspace_product_line_updated_idx
  on public.studies(workspace_id, product_line, updated_at desc);

create index if not exists study_intent_versions_workspace_product_line_created_idx
  on public.study_intent_versions(workspace_id, product_line, created_at desc);

create index if not exists study_plan_versions_workspace_product_line_created_idx
  on public.study_plan_versions(workspace_id, product_line, created_at desc);

create index if not exists workflow_definitions_workspace_type_created_idx
  on public.workflow_definitions(workspace_id, workflow_type, created_at desc);
