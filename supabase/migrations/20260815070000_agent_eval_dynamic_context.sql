-- Trusted research loop: replayable Context refreshes and governed Agent Eval.

drop index if exists public.context_retrievals_one_per_run_idx;

alter table public.reasoning_decisions
  drop constraint if exists reasoning_decisions_trigger_check,
  add constraint reasoning_decisions_trigger_check check (
    trigger_type in ('checkpoint', 'resume', 'terminal', 'context_refresh')
  );

alter table public.reasoning_decision_candidates
  drop constraint if exists reasoning_candidates_action_check,
  add constraint reasoning_candidates_action_check check (
    action_type in ('continue', 'append_task', 'stop_expansion', 'finish_run', 'refresh_context')
  );

create table if not exists public.context_retrieval_bindings (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  task_id bigint references public.study_tasks(id) on delete set null,
  reasoning_decision_id bigint not null references public.reasoning_decisions(id) on delete restrict,
  retrieval_id bigint not null unique references public.context_retrievals(id) on delete restrict,
  trigger_type text not null,
  trigger_reason text not null,
  request_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (reasoning_decision_id),
  constraint context_retrieval_bindings_trigger_check check (
    trigger_type in ('insufficient', 'conflicted', 'stale')
  ),
  constraint context_retrieval_bindings_reason_check check (length(trim(trigger_reason)) > 0),
  constraint context_retrieval_bindings_request_check check (jsonb_typeof(request_snapshot) = 'object')
);

create index if not exists context_retrieval_bindings_run_created_idx
  on public.context_retrieval_bindings(run_id, created_at, id);
create index if not exists context_retrieval_bindings_task_idx
  on public.context_retrieval_bindings(task_id) where task_id is not null;

create table if not exists public.agent_eval_suites (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  suite_key text not null,
  version integer not null,
  name text not null,
  description text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, suite_key, version),
  constraint agent_eval_suites_key_check check (suite_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  constraint agent_eval_suites_version_check check (version > 0),
  constraint agent_eval_suites_status_check check (status in ('draft', 'active', 'archived')),
  constraint agent_eval_suites_name_check check (length(trim(name)) > 0)
);

create table if not exists public.agent_eval_cases (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  suite_id bigint not null references public.agent_eval_suites(id) on delete cascade,
  case_key text not null,
  title text not null,
  trust_dimension text not null,
  instruction text not null,
  expected jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (suite_id, case_key),
  constraint agent_eval_cases_key_check check (case_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  constraint agent_eval_cases_dimension_check check (
    trust_dimension in ('fabricated_citation', 'persona_convergence')
  ),
  constraint agent_eval_cases_instruction_check check (length(trim(instruction)) > 0),
  constraint agent_eval_cases_expected_check check (jsonb_typeof(expected) = 'object')
);

create table if not exists public.agent_eval_case_sources (
  id bigint generated always as identity primary key,
  evaluation_case_id bigint not null references public.agent_eval_cases(id) on delete cascade,
  source_type text not null,
  context_asset_version_id bigint references public.context_asset_versions(id) on delete cascade,
  report_version_id bigint references public.report_versions(id) on delete cascade,
  persona_id bigint references public.study_personas(id) on delete cascade,
  source_public_id text not null,
  source_hash text not null,
  created_at timestamptz not null default now(),
  unique (evaluation_case_id, source_type, source_public_id),
  constraint agent_eval_case_sources_type_check check (
    source_type in ('context_asset_version', 'report_version', 'persona')
  ),
  constraint agent_eval_case_sources_one_reference_check check (
    num_nonnulls(context_asset_version_id, report_version_id, persona_id) = 1
  ),
  constraint agent_eval_case_sources_hash_check check (source_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.agent_eval_case_labels (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  evaluation_case_id bigint not null references public.agent_eval_cases(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  labeled_by bigint references public.users(id) on delete set null,
  label text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint agent_eval_case_labels_label_check check (label in ('pass', 'fail', 'needs_review'))
);

create table if not exists public.agent_eval_runs (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  suite_id bigint not null references public.agent_eval_suites(id) on delete restrict,
  created_by bigint references public.users(id) on delete set null,
  evaluator_version text not null,
  status text not null default 'running',
  case_count integer not null default 0,
  passed_count integer not null default 0,
  failed_count integer not null default 0,
  needs_review_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint agent_eval_runs_status_check check (status in ('running', 'completed', 'failed')),
  constraint agent_eval_runs_counts_check check (
    case_count >= 0 and passed_count >= 0 and failed_count >= 0 and needs_review_count >= 0
  )
);

create table if not exists public.agent_eval_results (
  id bigint generated always as identity primary key,
  evaluation_run_id bigint not null references public.agent_eval_runs(id) on delete cascade,
  evaluation_case_id bigint not null references public.agent_eval_cases(id) on delete restrict,
  candidate_output jsonb not null default '{}'::jsonb,
  judge_result text not null,
  judge_reasons jsonb not null default '[]'::jsonb,
  source_snapshot jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (evaluation_run_id, evaluation_case_id),
  constraint agent_eval_results_judge_check check (judge_result in ('pass', 'fail', 'needs_review')),
  constraint agent_eval_results_candidate_check check (jsonb_typeof(candidate_output) = 'object'),
  constraint agent_eval_results_reasons_check check (jsonb_typeof(judge_reasons) = 'array'),
  constraint agent_eval_results_sources_check check (jsonb_typeof(source_snapshot) = 'array')
);

create index if not exists agent_eval_suites_workspace_updated_idx
  on public.agent_eval_suites(workspace_id, created_at desc, id);
create index if not exists agent_eval_cases_suite_idx on public.agent_eval_cases(suite_id, id);
create index if not exists agent_eval_case_sources_case_idx on public.agent_eval_case_sources(evaluation_case_id, id);
create index if not exists agent_eval_case_labels_case_idx on public.agent_eval_case_labels(evaluation_case_id, created_at desc);
create index if not exists agent_eval_runs_workspace_started_idx on public.agent_eval_runs(workspace_id, started_at desc, id);
create index if not exists agent_eval_results_run_idx on public.agent_eval_results(evaluation_run_id, id);

alter table public.context_retrieval_bindings enable row level security;
alter table public.agent_eval_suites enable row level security;
alter table public.agent_eval_cases enable row level security;
alter table public.agent_eval_case_sources enable row level security;
alter table public.agent_eval_case_labels enable row level security;
alter table public.agent_eval_runs enable row level security;
alter table public.agent_eval_results enable row level security;

create policy context_retrieval_bindings_select_member on public.context_retrieval_bindings for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy agent_eval_suites_select_member on public.agent_eval_suites for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy agent_eval_cases_select_member on public.agent_eval_cases for select to authenticated
using (exists (select 1 from public.agent_eval_suites suite where suite.id = suite_id and public.is_workspace_member(suite.workspace_id)));
create policy agent_eval_case_sources_select_member on public.agent_eval_case_sources for select to authenticated
using (exists (
  select 1 from public.agent_eval_cases evaluation_case
  join public.agent_eval_suites suite on suite.id = evaluation_case.suite_id
  where evaluation_case.id = evaluation_case_id and public.is_workspace_member(suite.workspace_id)
));
create policy agent_eval_case_labels_select_member on public.agent_eval_case_labels for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy agent_eval_runs_select_member on public.agent_eval_runs for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy agent_eval_results_select_member on public.agent_eval_results for select to authenticated
using (exists (select 1 from public.agent_eval_runs run where run.id = evaluation_run_id and public.is_workspace_member(run.workspace_id)));

grant select on public.context_retrieval_bindings, public.agent_eval_suites, public.agent_eval_cases,
  public.agent_eval_case_sources, public.agent_eval_case_labels, public.agent_eval_runs,
  public.agent_eval_results to authenticated;
