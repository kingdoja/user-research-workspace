create table if not exists public.interview_questions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  project_id bigint not null references public.interview_projects(id) on delete cascade,
  position integer not null,
  content text not null,
  question_type text not null default 'open',
  options jsonb not null default '[]'::jsonb,
  ai_prompt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, position),
  constraint interview_questions_content_not_blank check (length(trim(content)) > 0),
  constraint interview_questions_type_check check (question_type in ('open', 'single', 'multiple'))
);

create index if not exists interview_questions_project_id_idx on public.interview_questions(project_id);

create table if not exists public.interview_invitations (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  project_id bigint not null references public.interview_projects(id) on delete cascade,
  created_by bigint not null references public.users(id) on delete restrict,
  token text not null unique,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists interview_invitations_project_id_idx on public.interview_invitations(project_id);
create index if not exists interview_invitations_token_idx on public.interview_invitations(token);

alter table public.interview_sessions
  alter column persona_id drop not null,
  add column if not exists session_type text not null default 'ai',
  add column if not exists participant_name text,
  add column if not exists participant_email text,
  add constraint interview_sessions_type_check check (session_type in ('ai', 'human'));

with first_sessions as (
  select distinct on (session.project_id) session.id, session.project_id
  from public.interview_sessions session
  where session.session_type = 'ai'
  order by session.project_id, session.created_at, session.id
), ordered_questions as (
  select first_sessions.project_id,
         row_number() over (partition by first_sessions.project_id order by message.turn_index)::int as position,
         message.content
  from first_sessions
  join public.interview_messages message on message.session_id = first_sessions.id
  where message.role = 'interviewer'
)
insert into public.interview_questions (public_id, project_id, position, content)
select 'inq_' || replace(gen_random_uuid()::text, '-', ''), project_id, position, content
from ordered_questions
on conflict (project_id, position) do nothing;

alter table public.interview_questions enable row level security;
alter table public.interview_invitations enable row level security;

drop policy if exists interview_questions_select_member on public.interview_questions;
create policy interview_questions_select_member on public.interview_questions for select to authenticated
using (exists (
  select 1 from public.interview_projects project
  where project.id = project_id and public.is_workspace_member(project.workspace_id)
));

drop policy if exists interview_invitations_select_member on public.interview_invitations;
create policy interview_invitations_select_member on public.interview_invitations for select to authenticated
using (exists (
  select 1 from public.interview_projects project
  where project.id = project_id and public.is_workspace_member(project.workspace_id)
));

grant select on public.interview_questions, public.interview_invitations to authenticated;
