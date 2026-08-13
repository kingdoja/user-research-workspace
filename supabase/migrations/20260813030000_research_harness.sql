create table if not exists public.study_tasks (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  position integer not null,
  task_key text not null,
  title text not null,
  tool_name text not null,
  status text not null default 'pending',
  depends_on jsonb not null default '[]'::jsonb,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error_message text,
  attempt integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, position),
  unique (run_id, task_key),
  constraint study_tasks_position_check check (position >= 0),
  constraint study_tasks_status_check check (
    status in ('pending', 'running', 'completed', 'failed', 'skipped', 'waiting_input')
  ),
  constraint study_tasks_depends_on_check check (jsonb_typeof(depends_on) = 'array')
);

create index if not exists study_tasks_study_created_idx
  on public.study_tasks(study_id, created_at, id);
create index if not exists study_tasks_run_position_idx
  on public.study_tasks(run_id, position);
create index if not exists study_tasks_active_idx
  on public.study_tasks(run_id, status, position)
  where status in ('pending', 'running', 'waiting_input');

create table if not exists public.study_tool_invocations (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  task_id bigint not null references public.study_tasks(id) on delete cascade,
  tool_name text not null,
  idempotency_key text not null unique,
  status text not null default 'running',
  arguments jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  attempt integer not null default 1,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint study_tool_invocations_status_check check (
    status in ('running', 'completed', 'failed', 'cancelled')
  )
);

create index if not exists study_tool_invocations_run_started_idx
  on public.study_tool_invocations(run_id, started_at, id);
create index if not exists study_tool_invocations_task_idx
  on public.study_tool_invocations(task_id, started_at, id);

create table if not exists public.study_artifacts (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  task_id bigint references public.study_tasks(id) on delete set null,
  artifact_type text not null,
  title text not null,
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, task_id, artifact_type),
  constraint study_artifacts_type_not_blank check (length(trim(artifact_type)) > 0),
  constraint study_artifacts_title_not_blank check (length(trim(title)) > 0)
);

create index if not exists study_artifacts_study_created_idx
  on public.study_artifacts(study_id, created_at, id);
create index if not exists study_artifacts_run_type_idx
  on public.study_artifacts(run_id, artifact_type);

create table if not exists public.study_run_checkpoints (
  run_id bigint primary key references public.study_runs(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  cursor integer not null default 0,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint study_run_checkpoints_cursor_check check (cursor >= 0)
);

create index if not exists study_run_checkpoints_study_idx
  on public.study_run_checkpoints(study_id, updated_at desc);

create table if not exists public.study_job_queue (
  id bigint generated always as identity primary key,
  run_id bigint not null unique references public.study_runs(id) on delete cascade,
  status text not null default 'queued',
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt integer not null default 0,
  max_attempts integer not null default 3,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_job_queue_status_check check (
    status in ('queued', 'leased', 'completed', 'failed', 'cancelled')
  ),
  constraint study_job_queue_attempt_check check (attempt >= 0 and max_attempts between 1 and 10)
);

create index if not exists study_job_queue_claim_idx
  on public.study_job_queue(status, available_at, id)
  where status in ('queued', 'leased');

alter table public.study_tasks enable row level security;
alter table public.study_tool_invocations enable row level security;
alter table public.study_artifacts enable row level security;
alter table public.study_run_checkpoints enable row level security;
alter table public.study_job_queue enable row level security;

drop policy if exists study_tasks_select_member on public.study_tasks;
create policy study_tasks_select_member on public.study_tasks for select to authenticated
using (exists (
  select 1 from public.studies study
  where study.id = study_id and public.is_workspace_member(study.workspace_id)
));

drop policy if exists study_tool_invocations_select_member on public.study_tool_invocations;
create policy study_tool_invocations_select_member on public.study_tool_invocations for select to authenticated
using (exists (
  select 1 from public.studies study
  where study.id = study_id and public.is_workspace_member(study.workspace_id)
));

drop policy if exists study_artifacts_select_member on public.study_artifacts;
create policy study_artifacts_select_member on public.study_artifacts for select to authenticated
using (exists (
  select 1 from public.studies study
  where study.id = study_id and public.is_workspace_member(study.workspace_id)
));

drop policy if exists study_run_checkpoints_select_member on public.study_run_checkpoints;
create policy study_run_checkpoints_select_member on public.study_run_checkpoints for select to authenticated
using (exists (
  select 1 from public.studies study
  where study.id = study_id and public.is_workspace_member(study.workspace_id)
));

drop policy if exists study_job_queue_select_member on public.study_job_queue;
create policy study_job_queue_select_member on public.study_job_queue for select to authenticated
using (exists (
  select 1 from public.study_runs run
  join public.studies study on study.id = run.study_id
  where run.id = run_id and public.is_workspace_member(study.workspace_id)
));

grant select on public.study_tasks, public.study_tool_invocations, public.study_artifacts,
  public.study_run_checkpoints, public.study_job_queue to authenticated;
