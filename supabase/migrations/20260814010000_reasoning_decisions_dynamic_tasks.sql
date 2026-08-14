-- Auditable scheduler decisions and controlled dynamic task expansion.
create table if not exists public.reasoning_decisions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  decision_key text not null,
  sequence integer not null,
  trigger_type text not null default 'checkpoint',
  policy_version text not null,
  input_snapshot jsonb not null default '{}'::jsonb,
  artifact_refs jsonb not null default '[]'::jsonb,
  evidence_refs jsonb not null default '[]'::jsonb,
  budget_snapshot jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  chosen_action jsonb not null default '{}'::jsonb,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (run_id, decision_key),
  unique (run_id, sequence),
  constraint reasoning_decisions_sequence_check check (sequence >= 0),
  constraint reasoning_decisions_trigger_check check (trigger_type in ('checkpoint', 'resume', 'terminal')),
  constraint reasoning_decisions_reason_check check (length(trim(reason)) > 0),
  constraint reasoning_decisions_artifact_refs_check check (jsonb_typeof(artifact_refs) = 'array'),
  constraint reasoning_decisions_evidence_refs_check check (jsonb_typeof(evidence_refs) = 'array')
);

create table if not exists public.reasoning_decision_candidates (
  id bigint generated always as identity primary key,
  decision_id bigint not null references public.reasoning_decisions(id) on delete cascade,
  position integer not null,
  action_type text not null,
  score double precision not null default 0,
  allowed boolean not null default true,
  selected boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  rejection_reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (decision_id, position),
  constraint reasoning_candidates_position_check check (position >= 0),
  constraint reasoning_candidates_action_check check (
    action_type in ('continue', 'append_task', 'stop_expansion', 'finish_run')
  ),
  constraint reasoning_candidates_rejections_check check (jsonb_typeof(rejection_reasons) = 'array')
);

alter table public.study_tasks
  add column if not exists origin text not null default 'planned',
  add column if not exists generation integer not null default 0,
  add column if not exists reasoning_decision_id bigint;

alter table public.study_tasks
  drop constraint if exists study_tasks_origin_check,
  add constraint study_tasks_origin_check check (origin in ('planned', 'dynamic')),
  drop constraint if exists study_tasks_generation_check,
  add constraint study_tasks_generation_check check (generation >= 0),
  drop constraint if exists study_tasks_reasoning_decision_id_fkey,
  add constraint study_tasks_reasoning_decision_id_fkey
    foreign key (reasoning_decision_id) references public.reasoning_decisions(id) on delete set null;

alter table public.study_runs
  add column if not exists dynamic_task_count integer not null default 0,
  add column if not exists reasoning_policy_version text not null default 'deterministic-research-v1',
  add column if not exists expansion_stop_reason text;

alter table public.study_runs
  drop constraint if exists study_runs_dynamic_task_count_check,
  add constraint study_runs_dynamic_task_count_check check (dynamic_task_count >= 0);

create index if not exists reasoning_decisions_run_sequence_idx
  on public.reasoning_decisions(run_id, sequence);
create index if not exists reasoning_decisions_study_created_idx
  on public.reasoning_decisions(study_id, created_at, id);
create index if not exists reasoning_candidates_decision_position_idx
  on public.reasoning_decision_candidates(decision_id, position);
create index if not exists study_tasks_dynamic_idx
  on public.study_tasks(run_id, origin, generation, position);

alter table public.reasoning_decisions enable row level security;
alter table public.reasoning_decision_candidates enable row level security;

create policy reasoning_decisions_select_member on public.reasoning_decisions for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy reasoning_candidates_select_member on public.reasoning_decision_candidates for select to authenticated
using (exists (
  select 1 from public.reasoning_decisions decision
  where decision.id = decision_id and public.is_workspace_member(decision.workspace_id)
));

grant select on public.reasoning_decisions, public.reasoning_decision_candidates to authenticated;
