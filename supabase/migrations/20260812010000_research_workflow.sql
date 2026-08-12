alter table public.study_events
  add column if not exists run_id bigint references public.study_runs(id) on delete cascade;

create index if not exists study_events_run_id_idx on public.study_events(run_id);
create index if not exists study_events_study_run_created_idx
  on public.study_events(study_id, run_id, created_at, id);

create table if not exists public.study_personas (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint references public.study_runs(id) on delete cascade,
  name text not null,
  archetype text not null,
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint study_personas_name_not_blank check (length(trim(name)) > 0)
);

create index if not exists study_personas_study_id_idx on public.study_personas(study_id);
create index if not exists study_personas_run_id_idx on public.study_personas(run_id);

create table if not exists public.study_panels (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint references public.study_runs(id) on delete cascade,
  title text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  constraint study_panels_title_not_blank check (length(trim(title)) > 0)
);

create index if not exists study_panels_study_id_idx on public.study_panels(study_id);
create index if not exists study_panels_run_id_idx on public.study_panels(run_id);

create table if not exists public.study_panel_members (
  panel_id bigint not null references public.study_panels(id) on delete cascade,
  persona_id bigint not null references public.study_personas(id) on delete cascade,
  position integer not null,
  primary key (panel_id, persona_id),
  unique (panel_id, position)
);

create table if not exists public.study_interviews (
  id bigint generated always as identity primary key,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint references public.study_runs(id) on delete cascade,
  persona_id bigint not null references public.study_personas(id) on delete cascade,
  batch integer not null,
  objective text not null,
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint study_interviews_batch_check check (batch in (1, 2))
);

create index if not exists study_interviews_study_id_idx on public.study_interviews(study_id);
create index if not exists study_interviews_run_id_idx on public.study_interviews(run_id);
create index if not exists study_interviews_persona_id_idx on public.study_interviews(persona_id);

alter table public.study_personas enable row level security;
alter table public.study_panels enable row level security;
alter table public.study_panel_members enable row level security;
alter table public.study_interviews enable row level security;

drop policy if exists study_personas_select_member on public.study_personas;
create policy study_personas_select_member on public.study_personas for select to authenticated
using (exists (select 1 from public.studies s where s.id = study_id and public.is_workspace_member(s.workspace_id)));

drop policy if exists study_panels_select_member on public.study_panels;
create policy study_panels_select_member on public.study_panels for select to authenticated
using (exists (select 1 from public.studies s where s.id = study_id and public.is_workspace_member(s.workspace_id)));

drop policy if exists study_panel_members_select_member on public.study_panel_members;
create policy study_panel_members_select_member on public.study_panel_members for select to authenticated
using (exists (
  select 1 from public.study_panels p
  join public.studies s on s.id = p.study_id
  where p.id = panel_id and public.is_workspace_member(s.workspace_id)
));

drop policy if exists study_interviews_select_member on public.study_interviews;
create policy study_interviews_select_member on public.study_interviews for select to authenticated
using (exists (select 1 from public.studies s where s.id = study_id and public.is_workspace_member(s.workspace_id)));

grant select on public.study_personas, public.study_panels, public.study_panel_members, public.study_interviews
  to authenticated;
