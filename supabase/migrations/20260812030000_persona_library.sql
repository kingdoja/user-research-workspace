alter table public.study_personas
  add column if not exists workspace_id bigint references public.workspaces(id) on delete cascade,
  add column if not exists created_by bigint references public.users(id) on delete restrict,
  add column if not exists source text not null default 'generated',
  add column if not exists visibility text not null default 'workspace',
  add column if not exists updated_at timestamptz not null default now();

update public.study_personas persona
set workspace_id = studies.workspace_id,
    created_by = studies.created_by
from public.studies studies
where studies.id = persona.study_id
  and (persona.workspace_id is null or persona.created_by is null);

alter table public.study_personas
  alter column workspace_id set not null,
  alter column created_by set not null,
  alter column study_id drop not null;

alter table public.study_personas
  drop constraint if exists study_personas_source_check,
  add constraint study_personas_source_check check (source in ('generated', 'manual')),
  drop constraint if exists study_personas_visibility_check,
  add constraint study_personas_visibility_check check (visibility in ('private', 'workspace'));

create index if not exists study_personas_workspace_id_idx on public.study_personas(workspace_id);
create index if not exists study_personas_created_by_idx on public.study_personas(created_by);

drop policy if exists study_personas_select_member on public.study_personas;
create policy study_personas_select_member on public.study_personas for select to authenticated
using (
  public.is_workspace_member(workspace_id)
  and (
    visibility = 'workspace'
    or exists (select 1 from public.users u where u.id = created_by and u.auth_user_id = auth.uid())
  )
);
