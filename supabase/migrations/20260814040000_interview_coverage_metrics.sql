-- Immutable-by-session metric snapshots for realtime interview coverage and follow-up quality.
create table if not exists public.interview_session_metrics (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  session_id bigint not null unique references public.interview_sessions(id) on delete cascade,
  project_id bigint not null references public.interview_projects(id) on delete cascade,
  assignment_id bigint references public.strategy_assignments(id) on delete set null,
  question_count integer not null default 0,
  answered_question_count integer not null default 0,
  coverage_rate double precision not null default 0,
  followup_requested_count integer not null default 0,
  followup_answered_count integer not null default 0,
  followup_hit_rate double precision not null default 0,
  substantive_answer_count integer not null default 0,
  metric_version text not null default 'realtime-interview-metrics-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interview_session_metrics_counts_check check (
    question_count >= 0 and answered_question_count >= 0 and
    followup_requested_count >= 0 and followup_answered_count >= 0 and
    substantive_answer_count >= 0
  ),
  constraint interview_session_metrics_rates_check check (
    coverage_rate between 0 and 1 and followup_hit_rate between 0 and 1
  )
);

create index if not exists interview_session_metrics_project_idx
  on public.interview_session_metrics(project_id, updated_at desc);
create index if not exists interview_session_metrics_assignment_idx
  on public.interview_session_metrics(assignment_id, updated_at desc);

alter table public.interview_session_metrics enable row level security;
drop policy if exists interview_session_metrics_select_member on public.interview_session_metrics;
create policy interview_session_metrics_select_member on public.interview_session_metrics for select to authenticated
using (exists (
  select 1 from public.interview_projects project
  where project.id = project_id and public.is_workspace_member(project.workspace_id)
));

grant select on public.interview_session_metrics to authenticated;
