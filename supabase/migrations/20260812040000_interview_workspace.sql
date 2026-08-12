create table if not exists public.interview_projects (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint not null references public.users(id) on delete restrict,
  title text not null,
  objective text not null,
  status text not null default 'active',
  source_panel_id bigint references public.study_panels(id) on delete set null,
  source_study_id bigint references public.studies(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interview_projects_title_not_blank check (length(trim(title)) > 0),
  constraint interview_projects_objective_not_blank check (length(trim(objective)) > 0),
  constraint interview_projects_status_check check (status in ('active', 'completed', 'archived'))
);

create index if not exists interview_projects_workspace_id_idx on public.interview_projects(workspace_id);
create index if not exists interview_projects_source_panel_id_idx on public.interview_projects(source_panel_id);
create index if not exists interview_projects_source_study_id_idx on public.interview_projects(source_study_id);

create table if not exists public.interview_sessions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  project_id bigint not null references public.interview_projects(id) on delete cascade,
  persona_id bigint not null references public.study_personas(id) on delete restrict,
  status text not null default 'completed',
  summary text not null,
  insights jsonb not null default '[]'::jsonb,
  quotes jsonb not null default '[]'::jsonb,
  provider text,
  provider_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interview_sessions_status_check check (status in ('running', 'completed', 'failed'))
);

create index if not exists interview_sessions_project_id_idx on public.interview_sessions(project_id);
create index if not exists interview_sessions_persona_id_idx on public.interview_sessions(persona_id);

create table if not exists public.interview_messages (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.interview_sessions(id) on delete cascade,
  turn_index integer not null,
  role text not null,
  content text not null,
  created_at timestamptz not null default now(),
  unique (session_id, turn_index),
  constraint interview_messages_role_check check (role in ('interviewer', 'persona')),
  constraint interview_messages_content_not_blank check (length(trim(content)) > 0)
);

create index if not exists interview_messages_session_id_idx on public.interview_messages(session_id);

alter table public.interview_projects enable row level security;
alter table public.interview_sessions enable row level security;
alter table public.interview_messages enable row level security;

drop policy if exists interview_projects_select_member on public.interview_projects;
create policy interview_projects_select_member on public.interview_projects for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists interview_sessions_select_member on public.interview_sessions;
create policy interview_sessions_select_member on public.interview_sessions for select to authenticated
using (exists (
  select 1 from public.interview_projects project
  where project.id = project_id and public.is_workspace_member(project.workspace_id)
));

drop policy if exists interview_messages_select_member on public.interview_messages;
create policy interview_messages_select_member on public.interview_messages for select to authenticated
using (exists (
  select 1 from public.interview_sessions session
  join public.interview_projects project on project.id = session.project_id
  where session.id = session_id and public.is_workspace_member(project.workspace_id)
));

grant select on public.interview_projects, public.interview_sessions, public.interview_messages to authenticated;
