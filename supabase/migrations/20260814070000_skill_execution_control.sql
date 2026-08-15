-- Controlled Skill activation, immutable run bindings and remote execution audit.

alter table public.skill_versions
  add column if not exists executor_type text not null default 'unconfigured',
  add column if not exists executor_config jsonb not null default '{}'::jsonb,
  add column if not exists content_hash text;

update public.skill_versions version
set executor_type = case
      when version.manifest ->> 'executor' = 'declarative_unconfigured' then 'unconfigured'
      else coalesce(nullif(version.manifest ->> 'executorType', ''), 'unconfigured')
    end,
    executor_config = case
      when jsonb_typeof(version.manifest -> 'executorConfig') = 'object'
        then version.manifest -> 'executorConfig'
      else '{}'::jsonb
    end
where version.executor_type = 'unconfigured' and version.executor_config = '{}'::jsonb;

update public.skill_versions version
set content_hash = encode(digest(jsonb_build_object(
  'version', version.version,
  'manifest', version.manifest,
  'inputSchema', version.input_schema,
  'outputSchema', version.output_schema,
  'promptVersion', version.prompt_version,
  'artifactUri', version.artifact_uri,
  'executorType', version.executor_type,
  'executorConfig', version.executor_config
)::text, 'sha256'), 'hex')
where version.content_hash is null;

alter table public.skill_versions
  alter column content_hash set not null,
  drop constraint if exists skill_versions_executor_type_check,
  add constraint skill_versions_executor_type_check check (
    executor_type in ('unconfigured', 'declarative_http', 'mcp')
  ),
  drop constraint if exists skill_versions_executor_config_check,
  add constraint skill_versions_executor_config_check check (jsonb_typeof(executor_config) = 'object'),
  drop constraint if exists skill_versions_content_hash_check,
  add constraint skill_versions_content_hash_check check (content_hash ~ '^[0-9a-f]{64}$');

create or replace function public.reject_skill_version_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.skill_manifests skill where skill.id = old.skill_id
  ) then
    return old;
  end if;
  raise exception 'SKILL_VERSION_IMMUTABLE';
end;
$$;

drop trigger if exists skill_versions_immutable on public.skill_versions;
create trigger skill_versions_immutable
before update or delete on public.skill_versions
for each row execute function public.reject_skill_version_mutation();

create table if not exists public.workspace_skill_settings (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  skill_id bigint references public.skill_manifests(id) on delete cascade,
  skill_source text not null,
  skill_slug text not null,
  enabled boolean not null,
  pinned_version integer,
  updated_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, skill_source, skill_slug),
  constraint workspace_skill_settings_source_check check (skill_source in ('builtin', 'workspace')),
  constraint workspace_skill_settings_slug_check check (skill_slug ~ '^[A-Za-z][A-Za-z0-9_-]{1,79}$'),
  constraint workspace_skill_settings_version_check check (pinned_version is null or pinned_version > 0),
  constraint workspace_skill_settings_skill_check check (
    (skill_source = 'builtin' and skill_id is null)
    or (skill_source = 'workspace' and skill_id is not null)
  )
);

create unique index if not exists study_runs_id_study_idx
  on public.study_runs(id, study_id);

create table if not exists public.study_run_skill_bindings (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  skill_id bigint references public.skill_manifests(id) on delete restrict,
  skill_source text not null,
  skill_slug text not null,
  skill_version integer not null,
  executor_type text not null,
  executor_config jsonb not null default '{}'::jsonb,
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  content_hash text not null,
  enabled_at_lock boolean not null,
  locked_at timestamptz not null default now(),
  unique (run_id, skill_slug),
  constraint study_run_skill_bindings_source_check check (skill_source in ('builtin', 'workspace')),
  constraint study_run_skill_bindings_executor_check check (
    executor_type in ('builtin', 'declarative_http', 'mcp')
  ),
  constraint study_run_skill_bindings_version_check check (skill_version > 0),
  constraint study_run_skill_bindings_config_check check (jsonb_typeof(executor_config) = 'object'),
  constraint study_run_skill_bindings_input_check check (jsonb_typeof(input_schema) = 'object'),
  constraint study_run_skill_bindings_output_check check (jsonb_typeof(output_schema) = 'object'),
  constraint study_run_skill_bindings_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint study_run_skill_bindings_skill_check check (
    (skill_source = 'builtin' and skill_id is null)
    or (skill_source = 'workspace' and skill_id is not null)
  ),
  constraint study_run_skill_bindings_run_study_fkey
    foreign key (run_id, study_id) references public.study_runs(id, study_id) on delete cascade
);

create table if not exists public.skill_executions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  skill_id bigint not null references public.skill_manifests(id) on delete restrict,
  skill_version_id bigint not null references public.skill_versions(id) on delete restrict,
  actor_user_id bigint references public.users(id) on delete set null,
  executor_type text not null,
  status text not null default 'running',
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  request_hash text not null,
  response_hash text,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint skill_executions_executor_check check (executor_type in ('declarative_http', 'mcp')),
  constraint skill_executions_status_check check (status in ('running', 'completed', 'failed', 'cancelled')),
  constraint skill_executions_input_check check (jsonb_typeof(input) = 'object'),
  constraint skill_executions_output_check check (output is null or jsonb_typeof(output) in ('object', 'array')),
  constraint skill_executions_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint skill_executions_response_hash_check check (response_hash is null or response_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.skill_control_events (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  skill_id bigint references public.skill_manifests(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  skill_source text not null,
  skill_slug text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint skill_control_events_source_check check (skill_source in ('builtin', 'workspace')),
  constraint skill_control_events_payload_check check (jsonb_typeof(payload) = 'object')
);

alter table public.study_tool_invocations
  add column if not exists skill_binding_id bigint references public.study_run_skill_bindings(id) on delete set null,
  add column if not exists executor_type text,
  add column if not exists request_hash text,
  add column if not exists response_hash text;

insert into public.study_run_skill_bindings (
  public_id, workspace_id, study_id, run_id, skill_source, skill_slug, skill_version,
  executor_type, executor_config, input_schema, output_schema, content_hash, enabled_at_lock, locked_at
)
select 'skb_' || substr(md5(run.id::text || ':' || invocation.skill_slug), 1, 20),
       study.workspace_id, study.id, run.id, 'builtin', invocation.skill_slug,
       max(invocation.skill_version), 'builtin', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       encode(digest(jsonb_build_object(
         'source', 'builtin', 'slug', invocation.skill_slug,
         'version', max(invocation.skill_version), 'executorType', 'builtin'
       )::text, 'sha256'), 'hex'),
       true, min(invocation.started_at)
from public.study_tool_invocations invocation
join public.study_runs run on run.id = invocation.run_id
join public.studies study on study.id = run.study_id
where invocation.skill_slug is not null and invocation.skill_version is not null
group by study.workspace_id, study.id, run.id, invocation.skill_slug
on conflict (run_id, skill_slug) do nothing;

update public.study_tool_invocations invocation
set skill_binding_id = binding.id,
    executor_type = coalesce(invocation.executor_type, binding.executor_type)
from public.study_run_skill_bindings binding
where binding.run_id = invocation.run_id
  and binding.skill_slug = invocation.skill_slug
  and invocation.skill_binding_id is null;

create index if not exists workspace_skill_settings_workspace_idx
  on public.workspace_skill_settings(workspace_id, skill_source, enabled, skill_slug);
create index if not exists study_run_skill_bindings_run_idx
  on public.study_run_skill_bindings(run_id, skill_slug);
create index if not exists study_run_skill_bindings_skill_idx
  on public.study_run_skill_bindings(skill_slug, skill_version, locked_at desc);
create index if not exists skill_executions_workspace_started_idx
  on public.skill_executions(workspace_id, started_at desc, id desc);
create index if not exists skill_executions_skill_started_idx
  on public.skill_executions(skill_id, started_at desc, id desc);
create index if not exists skill_control_events_workspace_created_idx
  on public.skill_control_events(workspace_id, created_at desc, id desc);

create or replace function public.reject_study_run_skill_binding_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.workspaces workspace where workspace.id = old.workspace_id)
    or not exists (select 1 from public.study_runs run where run.id = old.run_id)
  ) then
    return old;
  end if;
  raise exception 'RUN_SKILL_BINDING_IMMUTABLE';
end;
$$;

drop trigger if exists study_run_skill_bindings_immutable on public.study_run_skill_bindings;
create trigger study_run_skill_bindings_immutable
before update or delete on public.study_run_skill_bindings
for each row execute function public.reject_study_run_skill_binding_mutation();

alter table public.workspace_skill_settings enable row level security;
alter table public.study_run_skill_bindings enable row level security;
alter table public.skill_executions enable row level security;
alter table public.skill_control_events enable row level security;

drop policy if exists workspace_skill_settings_select_member on public.workspace_skill_settings;
create policy workspace_skill_settings_select_member on public.workspace_skill_settings for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists study_run_skill_bindings_select_member on public.study_run_skill_bindings;
create policy study_run_skill_bindings_select_member on public.study_run_skill_bindings for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists skill_executions_select_member on public.skill_executions;
create policy skill_executions_select_member on public.skill_executions for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists skill_control_events_select_member on public.skill_control_events;
create policy skill_control_events_select_member on public.skill_control_events for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.workspace_skill_settings, public.study_run_skill_bindings,
  public.skill_executions, public.skill_control_events to authenticated;
