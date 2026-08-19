-- Persisted, replayable evaluation summaries for Agent Controller trajectories.
create table if not exists public.research_agent_trajectory_evaluations (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  evaluator_version text not null,
  controller_mode text not null default 'off',
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, evaluator_version),
  constraint research_agent_trajectory_mode_check check (controller_mode in ('off', 'shadow', 'active')),
  constraint research_agent_trajectory_metrics_check check (jsonb_typeof(metrics) = 'object')
);

create index if not exists research_agent_trajectory_workspace_idx
  on public.research_agent_trajectory_evaluations(workspace_id, created_at desc, id);
create index if not exists research_agent_trajectory_study_idx
  on public.research_agent_trajectory_evaluations(study_id, run_id, created_at desc);

alter table public.research_agent_trajectory_evaluations enable row level security;
create policy research_agent_trajectory_select_member
  on public.research_agent_trajectory_evaluations for select to authenticated
  using (public.is_workspace_member(workspace_id));

grant select on public.research_agent_trajectory_evaluations to authenticated;
