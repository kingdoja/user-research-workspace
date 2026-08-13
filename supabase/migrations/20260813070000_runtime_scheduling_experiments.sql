alter table public.study_runs
  add column if not exists workflow_type text not null default 'batch_research',
  add column if not exists workflow_version text not null default 'research-dag-v2',
  add column if not exists strategy_key text not null default 'default',
  add column if not exists strategy_version text not null default 'v1',
  add column if not exists experiment_assignment_id bigint,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists timeout_seconds integer not null default 1800;

alter table public.study_runs
  drop constraint if exists study_runs_workflow_type_check,
  add constraint study_runs_workflow_type_check check (workflow_type in ('realtime_agent', 'batch_research')),
  drop constraint if exists study_runs_timeout_seconds_check,
  add constraint study_runs_timeout_seconds_check check (timeout_seconds between 30 and 14400);

alter table public.study_tasks
  add column if not exists timeout_seconds integer not null default 300,
  add column if not exists cancel_requested_at timestamptz;

alter table public.study_tasks
  drop constraint if exists study_tasks_timeout_seconds_check,
  add constraint study_tasks_timeout_seconds_check check (timeout_seconds between 15 and 3600);

create table if not exists public.strategy_experiments (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  experiment_key text not null,
  name text not null,
  description text not null default '',
  workflow_type text not null default 'batch_research',
  status text not null default 'draft',
  allocation_salt text not null,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, experiment_key),
  constraint strategy_experiments_workflow_type_check check (workflow_type in ('realtime_agent', 'batch_research')),
  constraint strategy_experiments_status_check check (status in ('draft', 'active', 'paused', 'completed'))
);

create table if not exists public.strategy_variants (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  experiment_id bigint not null references public.strategy_experiments(id) on delete cascade,
  variant_key text not null,
  name text not null,
  strategy_version text not null,
  weight integer not null default 1,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (experiment_id, variant_key),
  constraint strategy_variants_weight_check check (weight between 1 and 10000)
);

create table if not exists public.strategy_assignments (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  experiment_id bigint not null references public.strategy_experiments(id) on delete cascade,
  variant_id bigint not null references public.strategy_variants(id) on delete restrict,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint references public.studies(id) on delete cascade,
  run_id bigint references public.study_runs(id) on delete cascade,
  subject_key text not null,
  allocation_hash text not null,
  created_at timestamptz not null default now(),
  unique (run_id)
);

create index if not exists strategy_assignments_subject_idx
  on public.strategy_assignments(experiment_id, subject_key, created_at desc);

create table if not exists public.strategy_metrics (
  id bigint generated always as identity primary key,
  assignment_id bigint not null references public.strategy_assignments(id) on delete cascade,
  metric_key text not null,
  metric_value double precision not null,
  metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  unique (assignment_id, metric_key)
);

alter table public.study_runs
  drop constraint if exists study_runs_experiment_assignment_id_fkey,
  add constraint study_runs_experiment_assignment_id_fkey
    foreign key (experiment_assignment_id) references public.strategy_assignments(id) on delete set null;

create table if not exists public.provider_runtime_slots (
  id bigint generated always as identity primary key,
  run_id bigint not null unique references public.study_runs(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  provider_name text not null,
  lease_owner text not null,
  lease_expires_at timestamptz not null,
  acquired_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.provider_rate_windows (
  provider_name text not null,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (provider_name, workspace_id, window_started_at),
  constraint provider_rate_windows_request_count_check check (request_count >= 0)
);

create index if not exists study_runs_workflow_strategy_idx
  on public.study_runs(workflow_type, strategy_key, strategy_version, created_at desc);
create index if not exists study_runs_cancel_requested_idx
  on public.study_runs(cancel_requested_at) where cancel_requested_at is not null and cancelled_at is null;
create index if not exists strategy_experiments_workspace_status_idx
  on public.strategy_experiments(workspace_id, workflow_type, status, updated_at desc);
create index if not exists strategy_assignments_workspace_created_idx
  on public.strategy_assignments(workspace_id, created_at desc);
create index if not exists strategy_metrics_key_idx
  on public.strategy_metrics(metric_key, recorded_at desc);
create index if not exists provider_runtime_slots_scope_idx
  on public.provider_runtime_slots(provider_name, workspace_id, lease_expires_at);

alter table public.strategy_experiments enable row level security;
alter table public.strategy_variants enable row level security;
alter table public.strategy_assignments enable row level security;
alter table public.strategy_metrics enable row level security;
alter table public.provider_runtime_slots enable row level security;
alter table public.provider_rate_windows enable row level security;

create policy strategy_experiments_select_member on public.strategy_experiments for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy strategy_variants_select_member on public.strategy_variants for select to authenticated
using (exists (
  select 1 from public.strategy_experiments experiment
  where experiment.id = experiment_id and public.is_workspace_member(experiment.workspace_id)
));

create policy strategy_assignments_select_member on public.strategy_assignments for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy strategy_metrics_select_member on public.strategy_metrics for select to authenticated
using (exists (
  select 1 from public.strategy_assignments assignment
  where assignment.id = assignment_id and public.is_workspace_member(assignment.workspace_id)
));

create policy provider_runtime_slots_select_member on public.provider_runtime_slots for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy provider_rate_windows_select_member on public.provider_rate_windows for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.strategy_experiments, public.strategy_variants, public.strategy_assignments,
  public.strategy_metrics, public.provider_runtime_slots, public.provider_rate_windows to authenticated;
