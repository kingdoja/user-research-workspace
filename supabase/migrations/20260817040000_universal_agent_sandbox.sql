-- Universal Agent conversations, persistent workspace files and governed sandbox Skills.
-- Untrusted code is sent to an allowlisted isolated runner; it is never evaluated by PostgreSQL
-- or the Next.js process.

create table if not exists public.agent_threads (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  title text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_threads_title_check check (length(trim(title)) between 2 and 160),
  constraint agent_threads_status_check check (status in ('active', 'archived'))
);

create table if not exists public.agent_messages (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  thread_id bigint not null references public.agent_threads(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  role text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_messages_role_check check (role in ('user', 'assistant', 'tool', 'system')),
  constraint agent_messages_content_check check (length(content) between 1 and 120000),
  constraint agent_messages_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.agent_runs (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  thread_id bigint not null references public.agent_threads(id) on delete cascade,
  initiated_by bigint references public.users(id) on delete set null,
  user_message_id bigint not null references public.agent_messages(id) on delete restrict,
  objective text not null,
  status text not null default 'running',
  max_steps integer not null default 6,
  steps_used integer not null default 0,
  external_execution_allowed boolean not null default false,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint agent_runs_status_check check (status in ('running', 'completed', 'failed', 'cancelled')),
  constraint agent_runs_step_limits_check check (max_steps between 1 and 12 and steps_used between 0 and max_steps),
  constraint agent_runs_objective_check check (length(objective) between 1 and 12000)
);

create table if not exists public.agent_workspace_files (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  path text not null,
  content text not null,
  media_type text not null default 'text/plain',
  version integer not null default 1,
  byte_size integer not null,
  checksum text not null,
  updated_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, path),
  constraint agent_workspace_files_path_check check (
    length(path) between 1 and 240
    and path !~ '(^|/)\.\.(/|$)'
    and path !~ '^/'
    and path !~ '^skills/'
    and path !~ '[[:cntrl:]]'
  ),
  constraint agent_workspace_files_version_check check (version > 0),
  constraint agent_workspace_files_size_check check (byte_size between 0 and 262144),
  constraint agent_workspace_files_checksum_check check (checksum ~ '^[a-f0-9]{64}$')
);

create table if not exists public.agent_run_skill_bindings (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  run_id bigint not null references public.agent_runs(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  skill_id bigint not null references public.skill_manifests(id) on delete restrict,
  skill_version_id bigint not null references public.skill_versions(id) on delete restrict,
  skill_public_id text not null,
  skill_slug text not null,
  skill_name text not null,
  skill_version integer not null,
  executor_type text not null,
  executor_config jsonb not null,
  input_schema jsonb not null,
  output_schema jsonb not null,
  package_content jsonb not null default '{}'::jsonb,
  capability_grants jsonb not null default '[]'::jsonb,
  content_hash text not null,
  locked_at timestamptz not null default now(),
  unique (run_id, skill_slug),
  constraint agent_run_skill_bindings_executor_check check (executor_type in ('declarative_http', 'mcp', 'sandbox')),
  constraint agent_run_skill_bindings_version_check check (skill_version > 0),
  constraint agent_run_skill_bindings_json_check check (
    jsonb_typeof(executor_config) = 'object'
    and jsonb_typeof(input_schema) = 'object'
    and jsonb_typeof(output_schema) = 'object'
    and jsonb_typeof(package_content) = 'object'
    and jsonb_typeof(capability_grants) = 'array'
  ),
  constraint agent_run_skill_bindings_hash_check check (content_hash ~ '^[a-f0-9]{64}$')
);

create table if not exists public.agent_steps (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  run_id bigint not null references public.agent_runs(id) on delete cascade,
  sequence integer not null,
  kind text not null,
  status text not null default 'running',
  decision_summary text not null default '',
  tool_name text,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  request_hash text not null,
  response_hash text,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, sequence),
  constraint agent_steps_sequence_check check (sequence > 0),
  constraint agent_steps_kind_check check (kind in ('decision', 'tool', 'assistant')),
  constraint agent_steps_status_check check (status in ('running', 'completed', 'failed', 'blocked')),
  constraint agent_steps_input_check check (jsonb_typeof(input) = 'object'),
  constraint agent_steps_output_check check (output is null or jsonb_typeof(output) in ('object', 'array')),
  constraint agent_steps_request_hash_check check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint agent_steps_response_hash_check check (response_hash is null or response_hash ~ '^[a-f0-9]{64}$')
);

create table if not exists public.sandbox_executions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  agent_run_id bigint references public.agent_runs(id) on delete cascade,
  agent_step_id bigint references public.agent_steps(id) on delete set null,
  skill_binding_id bigint references public.agent_run_skill_bindings(id) on delete restrict,
  actor_user_id bigint references public.users(id) on delete set null,
  runner_protocol text not null default 'atypica.sandbox/v1',
  language text not null,
  entrypoint text not null,
  network_access boolean not null default false,
  limits jsonb not null,
  status text not null default 'running',
  input_hash text not null,
  output jsonb,
  output_hash text,
  exit_code integer,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint sandbox_executions_protocol_check check (runner_protocol = 'atypica.sandbox/v1'),
  constraint sandbox_executions_language_check check (language in ('javascript', 'python')),
  constraint sandbox_executions_status_check check (status in ('running', 'completed', 'failed', 'cancelled')),
  constraint sandbox_executions_limits_check check (jsonb_typeof(limits) = 'object'),
  constraint sandbox_executions_output_check check (output is null or jsonb_typeof(output) in ('object', 'array')),
  constraint sandbox_executions_input_hash_check check (input_hash ~ '^[a-f0-9]{64}$'),
  constraint sandbox_executions_output_hash_check check (output_hash is null or output_hash ~ '^[a-f0-9]{64}$')
);

-- Add sandbox as a governed Skill executor and allow code-bearing v2 packages.
alter table public.skill_versions
  drop constraint if exists skill_versions_executor_type_check,
  add constraint skill_versions_executor_type_check check (
    executor_type in ('unconfigured', 'declarative_http', 'mcp', 'sandbox')
  ),
  drop constraint if exists skill_versions_package_format_check,
  add constraint skill_versions_package_format_check check (
    package_format in ('inline', 'atypica.skill/v1', 'atypica.skill/v2')
  );

alter table public.workspace_skill_capability_grants
  drop constraint if exists workspace_skill_capability_grants_capability_check,
  add constraint workspace_skill_capability_grants_capability_check
    check (capability in ('network', 'context_read', 'files_read', 'files_write', 'provider_invoke', 'code_execute'));

alter table public.skill_executor_health_checks
  drop constraint if exists skill_executor_health_checks_executor_check,
  add constraint skill_executor_health_checks_executor_check
    check (executor_type in ('declarative_http', 'mcp', 'sandbox'));

alter table public.skill_executions
  drop constraint if exists skill_executions_executor_check,
  add constraint skill_executions_executor_check check (executor_type in ('declarative_http', 'mcp', 'sandbox'));

alter table public.study_run_skill_bindings
  drop constraint if exists study_run_skill_bindings_executor_check,
  add constraint study_run_skill_bindings_executor_check check (
    executor_type in ('builtin', 'declarative_http', 'mcp', 'sandbox')
  );

-- Reuse the existing provider routing control plane for Universal Agent reasoning runs.
alter table public.study_run_routing_bindings
  alter column run_id drop not null,
  add column if not exists agent_run_id bigint references public.agent_runs(id) on delete cascade;

alter table public.study_run_routing_bindings
  drop constraint if exists study_run_routing_bindings_subject_check,
  add constraint study_run_routing_bindings_subject_check check (
    (run_id is not null and agent_run_id is null)
    or (run_id is null and agent_run_id is not null)
  );

create unique index if not exists study_run_routing_bindings_agent_stage_idx
  on public.study_run_routing_bindings(agent_run_id, stage) where agent_run_id is not null;

alter table public.provider_route_decisions
  alter column run_id drop not null,
  add column if not exists agent_run_id bigint references public.agent_runs(id) on delete cascade;

alter table public.provider_route_decisions
  drop constraint if exists provider_route_decisions_subject_check,
  add constraint provider_route_decisions_subject_check check (
    (run_id is not null and agent_run_id is null)
    or (run_id is null and agent_run_id is not null)
  );

create index if not exists provider_route_decisions_agent_run_stage_idx
  on public.provider_route_decisions(agent_run_id, stage, created_at desc, id desc)
  where agent_run_id is not null;

create index if not exists agent_threads_workspace_updated_idx on public.agent_threads(workspace_id, updated_at desc, id desc);
create index if not exists agent_messages_thread_created_idx on public.agent_messages(thread_id, created_at, id);
create index if not exists agent_runs_thread_started_idx on public.agent_runs(thread_id, started_at desc, id desc);
create index if not exists agent_workspace_files_workspace_path_idx on public.agent_workspace_files(workspace_id, path);
create index if not exists agent_steps_run_sequence_idx on public.agent_steps(run_id, sequence);
create index if not exists sandbox_executions_workspace_started_idx on public.sandbox_executions(workspace_id, started_at desc, id desc);

create or replace function public.reject_agent_run_skill_binding_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.agent_runs run where run.id = old.run_id)
    or not exists (select 1 from public.workspaces workspace where workspace.id = old.workspace_id)
  ) then
    return old;
  end if;
  raise exception 'AGENT_RUN_SKILL_BINDING_IMMUTABLE';
end;
$$;

drop trigger if exists agent_run_skill_bindings_immutable on public.agent_run_skill_bindings;
create trigger agent_run_skill_bindings_immutable
before update or delete on public.agent_run_skill_bindings
for each row execute function public.reject_agent_run_skill_binding_mutation();

create or replace function public.reject_run_routing_binding_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if (old.run_id is not null and not exists (select 1 from public.study_runs run where run.id = old.run_id))
       or (old.agent_run_id is not null and not exists (select 1 from public.agent_runs run where run.id = old.agent_run_id))
       or not exists (select 1 from public.workspaces workspace where workspace.id = old.workspace_id) then
      return old;
    end if;
  end if;
  raise exception 'RUN_ROUTING_BINDING_IMMUTABLE';
end;
$$;

create or replace function public.protect_provider_route_decision_identity()
returns trigger language plpgsql as $$
begin
  if new.binding_id <> old.binding_id
     or new.run_id is distinct from old.run_id
     or new.agent_run_id is distinct from old.agent_run_id
     or new.workspace_id <> old.workspace_id
     or new.task_id is distinct from old.task_id
     or new.stage <> old.stage
     or new.chosen_route_id <> old.chosen_route_id
     or new.provider_name <> old.provider_name
     or new.model <> old.model
     or new.protocol <> old.protocol
     or new.selection_reason <> old.selection_reason
     or new.candidate_snapshot <> old.candidate_snapshot
     or new.estimated_cost_micros <> old.estimated_cost_micros
     or new.created_at <> old.created_at then
    raise exception 'PROVIDER_ROUTE_DECISION_IDENTITY_IMMUTABLE';
  end if;
  if old.finished_at is not null then
    raise exception 'PROVIDER_ROUTE_DECISION_RESULT_IMMUTABLE';
  end if;
  return new;
end;
$$;

alter table public.agent_threads enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_workspace_files enable row level security;
alter table public.agent_run_skill_bindings enable row level security;
alter table public.agent_steps enable row level security;
alter table public.sandbox_executions enable row level security;

create policy agent_threads_select_member on public.agent_threads for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy agent_messages_select_member on public.agent_messages for select to authenticated
using (exists (select 1 from public.agent_threads thread where thread.id = thread_id and public.is_workspace_member(thread.workspace_id)));
create policy agent_runs_select_member on public.agent_runs for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy agent_workspace_files_select_member on public.agent_workspace_files for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy agent_run_skill_bindings_select_member on public.agent_run_skill_bindings for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy agent_steps_select_member on public.agent_steps for select to authenticated
using (exists (select 1 from public.agent_runs run where run.id = run_id and public.is_workspace_member(run.workspace_id)));
create policy sandbox_executions_select_member on public.sandbox_executions for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.agent_threads, public.agent_messages, public.agent_runs,
  public.agent_workspace_files, public.agent_run_skill_bindings, public.agent_steps,
  public.sandbox_executions to authenticated;
