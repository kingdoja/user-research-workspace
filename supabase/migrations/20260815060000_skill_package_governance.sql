-- Governed declarative .skill packages. Packages store metadata and SKILL.md only;
-- they never contain executable source, binaries, or an execution sandbox.

alter table public.skill_manifests
  drop constraint if exists skill_manifests_status_check,
  add constraint skill_manifests_status_check check (status in ('draft', 'submitted', 'active', 'revoked', 'archived'));

alter table public.skill_versions
  add column if not exists package_format text not null default 'inline',
  add column if not exists package_content jsonb not null default '{}'::jsonb,
  add column if not exists signature_metadata jsonb not null default '{}'::jsonb,
  add column if not exists requested_capabilities jsonb not null default '[]'::jsonb;

alter table public.skill_versions
  drop constraint if exists skill_versions_package_format_check,
  add constraint skill_versions_package_format_check check (package_format in ('inline', 'atypica.skill/v1')),
  drop constraint if exists skill_versions_package_content_check,
  add constraint skill_versions_package_content_check check (jsonb_typeof(package_content) = 'object'),
  drop constraint if exists skill_versions_signature_metadata_check,
  add constraint skill_versions_signature_metadata_check check (jsonb_typeof(signature_metadata) = 'object'),
  drop constraint if exists skill_versions_requested_capabilities_check,
  add constraint skill_versions_requested_capabilities_check check (jsonb_typeof(requested_capabilities) = 'array');

create table if not exists public.workspace_skill_capability_grants (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  skill_id bigint not null references public.skill_manifests(id) on delete cascade,
  skill_version_id bigint not null references public.skill_versions(id) on delete cascade,
  capability text not null,
  scope jsonb not null default '{}'::jsonb,
  granted_by bigint references public.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  unique (workspace_id, skill_version_id, capability),
  constraint workspace_skill_capability_grants_capability_check check (capability in ('network', 'context_read', 'files_read', 'provider_invoke')),
  constraint workspace_skill_capability_grants_scope_check check (jsonb_typeof(scope) = 'object')
);

create table if not exists public.skill_executor_health_checks (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  skill_id bigint not null references public.skill_manifests(id) on delete cascade,
  skill_version_id bigint not null references public.skill_versions(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  executor_type text not null,
  status text not null,
  latency_ms integer,
  detail text,
  error_code text,
  created_at timestamptz not null default now(),
  constraint skill_executor_health_checks_executor_check check (executor_type in ('declarative_http', 'mcp')),
  constraint skill_executor_health_checks_status_check check (status in ('healthy', 'unhealthy')),
  constraint skill_executor_health_checks_latency_check check (latency_ms is null or latency_ms >= 0)
);

alter table public.study_run_skill_bindings
  add column if not exists capability_grants jsonb not null default '[]'::jsonb;

alter table public.study_run_skill_bindings
  drop constraint if exists study_run_skill_bindings_capability_grants_check,
  add constraint study_run_skill_bindings_capability_grants_check check (jsonb_typeof(capability_grants) = 'array');

-- Preserve compatibility for declarative Skills created before packages were introduced.
insert into public.workspace_skill_capability_grants (
  workspace_id, skill_id, skill_version_id, capability, scope, granted_by
)
select skill.workspace_id, skill.id, version.id, capability.capability, '{}'::jsonb, skill.owner_user_id
from public.skill_manifests skill
join public.skill_versions version on version.skill_id = skill.id
cross join lateral unnest(case version.executor_type
  when 'mcp' then array['network', 'provider_invoke']::text[]
  when 'declarative_http' then array['network']::text[]
  else array[]::text[]
end) as capability(capability)
where skill.workspace_id is not null
on conflict (workspace_id, skill_version_id, capability) do nothing;

create index if not exists workspace_skill_capability_grants_version_idx
  on public.workspace_skill_capability_grants(workspace_id, skill_version_id, capability);
create index if not exists skill_executor_health_checks_skill_created_idx
  on public.skill_executor_health_checks(skill_id, created_at desc, id desc);

create or replace function public.reject_workspace_skill_capability_grant_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.workspaces workspace where workspace.id = old.workspace_id)
    or not exists (select 1 from public.skill_versions version where version.id = old.skill_version_id)
  ) then
    return old;
  end if;
  raise exception 'SKILL_CAPABILITY_GRANT_IMMUTABLE';
end;
$$;

drop trigger if exists workspace_skill_capability_grants_immutable on public.workspace_skill_capability_grants;
create trigger workspace_skill_capability_grants_immutable
before update or delete on public.workspace_skill_capability_grants
for each row execute function public.reject_workspace_skill_capability_grant_mutation();

alter table public.workspace_skill_capability_grants enable row level security;
alter table public.skill_executor_health_checks enable row level security;

drop policy if exists workspace_skill_capability_grants_select_member on public.workspace_skill_capability_grants;
create policy workspace_skill_capability_grants_select_member on public.workspace_skill_capability_grants for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists skill_executor_health_checks_select_member on public.skill_executor_health_checks;
create policy skill_executor_health_checks_select_member on public.skill_executor_health_checks for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.workspace_skill_capability_grants, public.skill_executor_health_checks to authenticated;
