create table if not exists public.interview_project_personas (
  project_id bigint not null references public.interview_projects(id) on delete cascade,
  persona_id bigint not null references public.study_personas(id) on delete restrict,
  position integer not null,
  created_at timestamptz not null default now(),
  primary key (project_id, persona_id),
  unique (project_id, position)
);

create index if not exists interview_project_personas_persona_id_idx
  on public.interview_project_personas(persona_id);

insert into public.interview_project_personas (project_id, persona_id, position)
select project_id, persona_id,
       (row_number() over (partition by project_id order by first_seen, persona_id) - 1)::int
from (
  select project_id, persona_id, min(created_at) as first_seen
  from public.interview_sessions
  where persona_id is not null
  group by project_id, persona_id
) existing
on conflict (project_id, persona_id) do nothing;

create table if not exists public.interview_runs (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  project_id bigint not null references public.interview_projects(id) on delete cascade,
  status text not null default 'queued',
  provider text,
  provider_model text,
  provider_response_id text,
  prompt_version text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint interview_runs_status_check check (status in ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

create index if not exists interview_runs_project_created_idx
  on public.interview_runs(project_id, created_at desc, id desc);
create index if not exists interview_runs_active_status_idx
  on public.interview_runs(status) where status in ('queued', 'running');

create table if not exists public.interview_events (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.interview_projects(id) on delete cascade,
  run_id bigint references public.interview_runs(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint interview_events_type_not_blank check (length(trim(event_type)) > 0)
);

create index if not exists interview_events_project_created_idx
  on public.interview_events(project_id, created_at, id);
create index if not exists interview_events_run_created_idx
  on public.interview_events(run_id, created_at, id);

alter table public.interview_project_personas enable row level security;
alter table public.interview_runs enable row level security;
alter table public.interview_events enable row level security;

drop policy if exists interview_project_personas_select_member on public.interview_project_personas;
create policy interview_project_personas_select_member on public.interview_project_personas for select to authenticated
using (exists (
  select 1 from public.interview_projects project
  where project.id = project_id and public.is_workspace_member(project.workspace_id)
));

drop policy if exists interview_runs_select_member on public.interview_runs;
create policy interview_runs_select_member on public.interview_runs for select to authenticated
using (exists (
  select 1 from public.interview_projects project
  where project.id = project_id and public.is_workspace_member(project.workspace_id)
));

drop policy if exists interview_events_select_member on public.interview_events;
create policy interview_events_select_member on public.interview_events for select to authenticated
using (exists (
  select 1 from public.interview_projects project
  where project.id = project_id and public.is_workspace_member(project.workspace_id)
));

grant select on public.interview_project_personas, public.interview_runs, public.interview_events to authenticated;
