alter table public.interview_runs
  add column if not exists question_snapshot jsonb not null default '[]'::jsonb;

alter table public.interview_runs
  drop constraint if exists interview_runs_question_snapshot_check,
  add constraint interview_runs_question_snapshot_check check (jsonb_typeof(question_snapshot) = 'array');

alter table public.interview_sessions
  add column if not exists run_id bigint references public.interview_runs(id) on delete cascade;

create index if not exists interview_sessions_run_id_idx
  on public.interview_sessions(run_id);

create unique index if not exists interview_sessions_run_persona_unique
  on public.interview_sessions(run_id, persona_id)
  where run_id is not null and persona_id is not null;

create table if not exists public.interview_job_queue (
  id bigint generated always as identity primary key,
  run_id bigint not null unique references public.interview_runs(id) on delete cascade,
  status text not null default 'queued',
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt integer not null default 0,
  max_attempts integer not null default 3,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interview_job_queue_status_check check (
    status in ('queued', 'leased', 'completed', 'failed', 'cancelled')
  ),
  constraint interview_job_queue_attempt_check check (attempt >= 0 and max_attempts between 1 and 10)
);

create index if not exists interview_job_queue_claim_idx
  on public.interview_job_queue(status, available_at, id)
  where status in ('queued', 'leased');

alter table public.interview_job_queue enable row level security;

drop policy if exists interview_job_queue_select_member on public.interview_job_queue;
create policy interview_job_queue_select_member on public.interview_job_queue for select to authenticated
using (exists (
  select 1 from public.interview_runs run
  join public.interview_projects project on project.id = run.project_id
  where run.id = interview_job_queue.run_id and public.is_workspace_member(project.workspace_id)
));

grant select on public.interview_job_queue to authenticated;
