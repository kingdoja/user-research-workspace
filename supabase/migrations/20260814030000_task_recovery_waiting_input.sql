-- Durable task-level recovery: retry history, human input pauses and lease recovery.
alter table public.study_tasks
  add column if not exists max_attempts integer not null default 3,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_error_class text,
  add column if not exists retryable boolean,
  add column if not exists waiting_reason text,
  add column if not exists waiting_payload jsonb,
  add column if not exists waiting_since timestamptz,
  add column if not exists resumed_at timestamptz,
  add column if not exists resume_count integer not null default 0;

alter table public.study_tasks
  drop constraint if exists study_tasks_max_attempts_check,
  add constraint study_tasks_max_attempts_check check (max_attempts between 1 and 10),
  drop constraint if exists study_tasks_resume_count_check,
  add constraint study_tasks_resume_count_check check (resume_count >= 0),
  drop constraint if exists study_tasks_waiting_payload_check,
  add constraint study_tasks_waiting_payload_check check (waiting_payload is null or jsonb_typeof(waiting_payload) = 'object');

create index if not exists study_tasks_retry_ready_idx
  on public.study_tasks(run_id, next_attempt_at, position)
  where status = 'pending';

create table if not exists public.study_task_attempts (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  task_id bigint not null references public.study_tasks(id) on delete cascade,
  invocation_id bigint references public.study_tool_invocations(id) on delete set null,
  attempt integer not null,
  status text not null default 'running',
  error_class text,
  error_code text,
  error_message text,
  retryable boolean,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (task_id, attempt),
  constraint study_task_attempts_attempt_check check (attempt >= 1),
  constraint study_task_attempts_status_check check (
    status in ('running', 'completed', 'failed', 'interrupted', 'waiting_input', 'cancelled')
  ),
  constraint study_task_attempts_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists study_task_attempts_run_started_idx
  on public.study_task_attempts(run_id, started_at, id);
create index if not exists study_task_attempts_task_attempt_idx
  on public.study_task_attempts(task_id, attempt desc);

create table if not exists public.study_task_inputs (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  task_id bigint not null references public.study_tasks(id) on delete cascade,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  status text not null default 'pending',
  requested_at timestamptz not null default now(),
  submitted_at timestamptz,
  consumed_at timestamptz,
  submitted_by bigint references public.users(id) on delete set null,
  constraint study_task_inputs_status_check check (status in ('pending', 'submitted', 'consumed', 'cancelled')),
  constraint study_task_inputs_request_check check (jsonb_typeof(request_payload) = 'object'),
  constraint study_task_inputs_response_check check (response_payload is null or jsonb_typeof(response_payload) = 'object')
);

create unique index if not exists study_task_inputs_one_pending_idx
  on public.study_task_inputs(task_id)
  where status = 'pending';
create index if not exists study_task_inputs_run_status_idx
  on public.study_task_inputs(run_id, status, requested_at desc);

alter table public.study_tool_invocations
  drop constraint if exists study_tool_invocations_status_check,
  add constraint study_tool_invocations_status_check check (
    status in ('running', 'completed', 'failed', 'cancelled', 'interrupted', 'waiting_input')
  );

alter table public.study_runs
  drop constraint if exists study_runs_status_check,
  add constraint study_runs_status_check check (
    status in ('awaiting_provider', 'queued', 'running', 'waiting_input', 'completed', 'failed', 'cancelled')
  );

alter table public.studies
  drop constraint if exists studies_status_check,
  add constraint studies_status_check check (
    status in ('planning', 'awaiting_confirmation', 'queued', 'running', 'waiting_input', 'completed', 'cancelled', 'failed')
  );

alter table public.study_job_queue
  drop constraint if exists study_job_queue_status_check,
  add constraint study_job_queue_status_check check (
    status in ('queued', 'leased', 'waiting_input', 'completed', 'failed', 'cancelled')
  );

alter table public.study_task_attempts enable row level security;
alter table public.study_task_inputs enable row level security;

drop policy if exists study_task_attempts_select_member on public.study_task_attempts;
create policy study_task_attempts_select_member on public.study_task_attempts for select to authenticated
using (exists (
  select 1 from public.studies study
  where study.id = study_id and public.is_workspace_member(study.workspace_id)
));

drop policy if exists study_task_inputs_select_member on public.study_task_inputs;
create policy study_task_inputs_select_member on public.study_task_inputs for select to authenticated
using (exists (
  select 1 from public.studies study
  where study.id = study_id and public.is_workspace_member(study.workspace_id)
));

grant select on public.study_task_attempts, public.study_task_inputs to authenticated;
