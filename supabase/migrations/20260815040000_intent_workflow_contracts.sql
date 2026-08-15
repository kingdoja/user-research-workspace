-- Versioned intent contracts and compiled workflow definitions.
create table if not exists public.study_intent_versions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  version integer not null,
  schema_version text not null default 'research-intent-v1',
  lifecycle_status text not null,
  snapshot_reason text not null,
  supersedes_intent_version_id bigint,
  objective text not null,
  audience jsonb not null default '{}'::jsonb,
  study_type text not null,
  budget jsonb not null default '{}'::jsonb,
  data_scope jsonb not null default '{}'::jsonb,
  compliance jsonb not null default '{}'::jsonb,
  allowed_context_purposes text[] not null default array['intent_planning']::text[],
  requested_methods jsonb not null default '[]'::jsonb,
  exclusions jsonb not null default '[]'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  open_questions jsonb not null default '[]'::jsonb,
  source_brief text not null,
  clarification_answers jsonb not null default '[]'::jsonb,
  context_retrieval_id bigint references public.context_retrievals(id) on delete restrict,
  parser_source text not null,
  provider_response_id text,
  provider_model text,
  prompt_version text not null,
  content_hash text not null,
  confirmed_by bigint references public.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (study_id, version),
  unique (id, study_id),
  constraint study_intent_versions_version_check check (version > 0),
  constraint study_intent_versions_schema_check check (schema_version = 'research-intent-v1'),
  constraint study_intent_versions_lifecycle_check check (lifecycle_status in ('draft', 'confirmed')),
  constraint study_intent_versions_reason_check check (snapshot_reason in ('brief_creation', 'clarification', 'confirmation', 'legacy_backfill')),
  constraint study_intent_versions_study_type_check check (study_type in ('user_research', 'fast_insight', 'product_rnd', 'panel_only')),
  constraint study_intent_versions_audience_check check (jsonb_typeof(audience) = 'object'),
  constraint study_intent_versions_budget_check check (jsonb_typeof(budget) = 'object'),
  constraint study_intent_versions_data_scope_check check (jsonb_typeof(data_scope) = 'object'),
  constraint study_intent_versions_compliance_check check (jsonb_typeof(compliance) = 'object'),
  constraint study_intent_versions_methods_check check (jsonb_typeof(requested_methods) = 'array'),
  constraint study_intent_versions_exclusions_check check (jsonb_typeof(exclusions) = 'array'),
  constraint study_intent_versions_assumptions_check check (jsonb_typeof(assumptions) = 'array'),
  constraint study_intent_versions_questions_check check (jsonb_typeof(open_questions) = 'array'),
  constraint study_intent_versions_answers_check check (jsonb_typeof(clarification_answers) = 'array'),
  constraint study_intent_versions_purposes_check check (allowed_context_purposes <@ array['intent_planning']::text[]),
  constraint study_intent_versions_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint study_intent_versions_confirmation_check check (
    (lifecycle_status = 'confirmed' and confirmed_at is not null)
    or (lifecycle_status = 'draft' and confirmed_at is null and confirmed_by is null)
  )
);

alter table public.study_intent_versions
  add constraint study_intent_versions_supersedes_fkey
    foreign key (supersedes_intent_version_id, study_id)
    references public.study_intent_versions(id, study_id) on delete restrict;

alter table public.studies
  add column if not exists current_intent_version_id bigint;

alter table public.studies
  drop constraint if exists studies_current_intent_version_fkey,
  add constraint studies_current_intent_version_fkey
    foreign key (current_intent_version_id, id)
    references public.study_intent_versions(id, study_id) on delete restrict;

alter table public.study_plan_versions
  add column if not exists intent_version_id bigint;

alter table public.study_plan_versions
  drop constraint if exists study_plan_versions_intent_version_fkey,
  add constraint study_plan_versions_intent_version_fkey
    foreign key (intent_version_id, study_id)
    references public.study_intent_versions(id, study_id) on delete restrict;

create table if not exists public.workflow_definitions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  version integer not null,
  schema_version text not null default 'workflow-definition-v1',
  workflow_type text not null,
  template_key text not null,
  template_version text not null,
  intent_version_id bigint not null,
  plan_version_id bigint not null,
  task_graph jsonb not null default '[]'::jsonb,
  runtime_limits jsonb not null default '{}'::jsonb,
  skill_requirements jsonb not null default '[]'::jsonb,
  context_policy jsonb not null default '{}'::jsonb,
  output_contracts jsonb not null default '[]'::jsonb,
  evidence_gates jsonb not null default '{}'::jsonb,
  compiler_version text not null,
  content_hash text not null,
  compiled_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (study_id, version),
  unique (id, study_id),
  unique (study_id, intent_version_id, plan_version_id),
  constraint workflow_definitions_version_check check (version > 0),
  constraint workflow_definitions_schema_check check (schema_version = 'workflow-definition-v1'),
  constraint workflow_definitions_type_check check (workflow_type = 'batch_research'),
  constraint workflow_definitions_task_graph_check check (jsonb_typeof(task_graph) = 'array'),
  constraint workflow_definitions_runtime_limits_check check (jsonb_typeof(runtime_limits) = 'object'),
  constraint workflow_definitions_skill_requirements_check check (jsonb_typeof(skill_requirements) = 'array'),
  constraint workflow_definitions_context_policy_check check (jsonb_typeof(context_policy) = 'object'),
  constraint workflow_definitions_output_contracts_check check (jsonb_typeof(output_contracts) = 'array'),
  constraint workflow_definitions_evidence_gates_check check (jsonb_typeof(evidence_gates) = 'object'),
  constraint workflow_definitions_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint workflow_definitions_intent_fkey foreign key (intent_version_id, study_id)
    references public.study_intent_versions(id, study_id) on delete restrict,
  constraint workflow_definitions_plan_fkey foreign key (plan_version_id, study_id)
    references public.study_plan_versions(id, study_id) on delete restrict
);

alter table public.study_runs
  add column if not exists intent_version_id bigint,
  add column if not exists workflow_definition_id bigint;

alter table public.study_runs
  drop constraint if exists study_runs_intent_version_fkey,
  add constraint study_runs_intent_version_fkey
    foreign key (intent_version_id, study_id)
    references public.study_intent_versions(id, study_id) on delete restrict,
  drop constraint if exists study_runs_workflow_definition_fkey,
  add constraint study_runs_workflow_definition_fkey
    foreign key (workflow_definition_id, study_id)
    references public.workflow_definitions(id, study_id) on delete restrict;

create index if not exists study_intent_versions_workspace_created_idx on public.study_intent_versions(workspace_id, created_at desc);
create index if not exists study_intent_versions_study_version_idx on public.study_intent_versions(study_id, version desc);
create index if not exists study_intent_versions_context_idx on public.study_intent_versions(context_retrieval_id) where context_retrieval_id is not null;
create index if not exists study_plan_versions_intent_idx on public.study_plan_versions(intent_version_id) where intent_version_id is not null;
create index if not exists workflow_definitions_workspace_created_idx on public.workflow_definitions(workspace_id, created_at desc);
create index if not exists workflow_definitions_study_version_idx on public.workflow_definitions(study_id, version desc);
create index if not exists study_runs_intent_workflow_idx on public.study_runs(intent_version_id, workflow_definition_id, created_at desc)
  where intent_version_id is not null and workflow_definition_id is not null;

create or replace function public.prevent_intent_workflow_contract_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'intent and workflow contracts are immutable';
  end if;
  if pg_trigger_depth() = 1
     and exists (select 1 from public.studies study where study.id = old.study_id) then
    raise exception 'intent and workflow contracts are immutable';
  end if;
  return old;
end;
$$;

drop trigger if exists study_intent_versions_immutable on public.study_intent_versions;
create trigger study_intent_versions_immutable before update or delete on public.study_intent_versions
for each row execute function public.prevent_intent_workflow_contract_mutation();

drop trigger if exists workflow_definitions_immutable on public.workflow_definitions;
create trigger workflow_definitions_immutable before update or delete on public.workflow_definitions
for each row execute function public.prevent_intent_workflow_contract_mutation();

alter table public.study_intent_versions enable row level security;
alter table public.workflow_definitions enable row level security;

create policy study_intent_versions_select_member on public.study_intent_versions for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy workflow_definitions_select_member on public.workflow_definitions for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.study_intent_versions, public.workflow_definitions to authenticated;
