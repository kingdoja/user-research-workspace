-- Cross-workspace collaboration packages and versioned provider routing control.
-- Public report share tokens remain a separate, read-only presentation mechanism.

create table if not exists public.collaboration_publications (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  publisher_workspace_id bigint not null references public.workspaces(id) on delete cascade,
  recipient_workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  artifact_type text not null,
  artifact_public_id text not null,
  artifact_version_public_id text,
  artifact_hash text not null,
  title text not null,
  summary text not null default '',
  snapshot jsonb not null,
  capabilities text[] not null default array['view']::text[],
  status text not null default 'draft',
  submitted_at timestamptz,
  responded_at timestamptz,
  responded_by bigint references public.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collaboration_publications_distinct_workspaces_check
    check (publisher_workspace_id <> recipient_workspace_id),
  constraint collaboration_publications_artifact_type_check
    check (artifact_type in ('study', 'report', 'context', 'skill')),
  constraint collaboration_publications_hash_check check (artifact_hash ~ '^[a-f0-9]{64}$'),
  constraint collaboration_publications_title_check check (length(trim(title)) between 2 and 160),
  constraint collaboration_publications_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  constraint collaboration_publications_capabilities_check check (
    cardinality(capabilities) between 1 and 3
    and capabilities <@ array['view', 'import', 'delegate']::text[]
    and capabilities @> array['view']::text[]
  ),
  constraint collaboration_publications_status_check
    check (status in ('draft', 'submitted', 'accepted', 'rejected', 'revoked'))
);

create table if not exists public.collaboration_imports (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  publication_id bigint not null references public.collaboration_publications(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  imported_by bigint references public.users(id) on delete set null,
  governance_status text not null default 'pending_review',
  local_reference jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (publication_id, workspace_id),
  constraint collaboration_imports_status_check
    check (governance_status in ('pending_review', 'approved', 'rejected', 'archived')),
  constraint collaboration_imports_reference_check check (jsonb_typeof(local_reference) = 'object')
);

create table if not exists public.collaboration_delegations (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  publication_id bigint references public.collaboration_publications(id) on delete set null,
  sender_workspace_id bigint not null references public.workspaces(id) on delete cascade,
  recipient_workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  assigned_to bigint references public.users(id) on delete set null,
  title text not null,
  instructions text not null default '',
  due_at timestamptz,
  status text not null default 'proposed',
  accepted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collaboration_delegations_distinct_workspaces_check
    check (sender_workspace_id <> recipient_workspace_id),
  constraint collaboration_delegations_title_check check (length(trim(title)) between 2 and 160),
  constraint collaboration_delegations_status_check
    check (status in ('proposed', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled'))
);

create table if not exists public.collaboration_events (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  publication_id bigint references public.collaboration_publications(id) on delete cascade,
  delegation_id bigint references public.collaboration_delegations(id) on delete cascade,
  actor_workspace_id bigint not null references public.workspaces(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint collaboration_events_target_check
    check ((publication_id is not null)::integer + (delegation_id is not null)::integer = 1),
  constraint collaboration_events_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists collaboration_publications_publisher_idx
  on public.collaboration_publications(publisher_workspace_id, updated_at desc, id desc);
create index if not exists collaboration_publications_recipient_idx
  on public.collaboration_publications(recipient_workspace_id, status, updated_at desc, id desc);
create index if not exists collaboration_delegations_sender_idx
  on public.collaboration_delegations(sender_workspace_id, updated_at desc, id desc);
create index if not exists collaboration_delegations_recipient_idx
  on public.collaboration_delegations(recipient_workspace_id, status, updated_at desc, id desc);
create index if not exists collaboration_events_publication_idx
  on public.collaboration_events(publication_id, created_at desc, id desc) where publication_id is not null;
create index if not exists collaboration_events_delegation_idx
  on public.collaboration_events(delegation_id, created_at desc, id desc) where delegation_id is not null;

create table if not exists public.provider_routing_policies (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  policy_key text not null,
  name text not null,
  stage text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, policy_key),
  constraint provider_routing_policies_key_check check (policy_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  constraint provider_routing_policies_stage_check
    check (stage in ('plan', 'research', 'reasoning', 'report', 'judge', 'followup')),
  constraint provider_routing_policies_name_check check (length(trim(name)) between 2 and 120)
);

create table if not exists public.provider_routing_policy_versions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  policy_id bigint not null references public.provider_routing_policies(id) on delete cascade,
  version integer not null,
  status text not null default 'draft',
  selection_mode text not null default 'weighted',
  max_estimated_cost_micros bigint,
  max_latency_ms integer,
  minimum_quality_tier text not null default 'standard',
  estimated_input_tokens integer not null default 10000,
  estimated_output_tokens integer not null default 2000,
  change_note text not null default '',
  created_by bigint references public.users(id) on delete set null,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  unique (policy_id, version),
  constraint provider_routing_policy_versions_version_check check (version > 0),
  constraint provider_routing_policy_versions_status_check check (status in ('draft', 'active', 'retired')),
  constraint provider_routing_policy_versions_mode_check check (selection_mode in ('weighted', 'priority')),
  constraint provider_routing_policy_versions_cost_check check (max_estimated_cost_micros is null or max_estimated_cost_micros >= 0),
  constraint provider_routing_policy_versions_latency_check check (max_latency_ms is null or max_latency_ms between 1 and 3600000),
  constraint provider_routing_policy_versions_quality_check check (minimum_quality_tier in ('basic', 'standard', 'high', 'premium')),
  constraint provider_routing_policy_versions_token_check
    check (estimated_input_tokens between 1 and 10000000 and estimated_output_tokens between 1 and 10000000)
);

create unique index if not exists provider_routing_policy_versions_one_active_idx
  on public.provider_routing_policy_versions(policy_id) where status = 'active';

create table if not exists public.provider_routing_routes (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  policy_version_id bigint not null references public.provider_routing_policy_versions(id) on delete cascade,
  route_key text not null,
  provider_name text not null,
  model text not null,
  protocol text not null default 'responses',
  priority integer not null default 100,
  weight integer not null default 1,
  quality_tier text not null default 'standard',
  expected_latency_ms integer,
  input_price_micros_per_million bigint not null,
  output_price_micros_per_million bigint not null,
  pricing_source text not null,
  pricing_effective_at date not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (policy_version_id, route_key),
  constraint provider_routing_routes_key_check check (route_key ~ '^[a-z][a-z0-9-]{0,79}$'),
  constraint provider_routing_routes_provider_check check (length(trim(provider_name)) between 2 and 80),
  constraint provider_routing_routes_model_check check (length(trim(model)) between 1 and 160),
  constraint provider_routing_routes_protocol_check check (protocol in ('responses', 'chat_completions')),
  constraint provider_routing_routes_priority_check check (priority between 1 and 10000),
  constraint provider_routing_routes_weight_check check (weight between 1 and 10000),
  constraint provider_routing_routes_quality_check check (quality_tier in ('basic', 'standard', 'high', 'premium')),
  constraint provider_routing_routes_latency_check check (expected_latency_ms is null or expected_latency_ms between 1 and 3600000),
  constraint provider_routing_routes_price_check
    check (input_price_micros_per_million >= 0 and output_price_micros_per_million >= 0),
  constraint provider_routing_routes_pricing_source_check check (length(trim(pricing_source)) between 2 and 240)
);

create table if not exists public.study_run_routing_bindings (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  stage text not null,
  policy_version_id bigint not null references public.provider_routing_policy_versions(id) on delete restrict,
  bound_at timestamptz not null default now(),
  unique (run_id, stage),
  constraint study_run_routing_bindings_stage_check
    check (stage in ('plan', 'research', 'reasoning', 'report', 'judge', 'followup'))
);

create table if not exists public.provider_route_decisions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  binding_id bigint not null references public.study_run_routing_bindings(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  task_id bigint references public.study_tasks(id) on delete set null,
  stage text not null,
  chosen_route_id bigint not null references public.provider_routing_routes(id) on delete restrict,
  provider_name text not null,
  model text not null,
  protocol text not null,
  selection_reason text not null,
  candidate_snapshot jsonb not null,
  estimated_cost_micros bigint not null,
  status text not null default 'selected',
  input_tokens bigint,
  output_tokens bigint,
  actual_cost_micros bigint,
  latency_ms integer,
  quality_score double precision,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint provider_route_decisions_stage_check
    check (stage in ('plan', 'research', 'reasoning', 'report', 'judge', 'followup')),
  constraint provider_route_decisions_protocol_check check (protocol in ('responses', 'chat_completions')),
  constraint provider_route_decisions_candidates_check check (jsonb_typeof(candidate_snapshot) = 'array'),
  constraint provider_route_decisions_estimated_cost_check check (estimated_cost_micros >= 0),
  constraint provider_route_decisions_status_check check (status in ('selected', 'completed', 'failed')),
  constraint provider_route_decisions_usage_check check (
    (input_tokens is null or input_tokens >= 0)
    and (output_tokens is null or output_tokens >= 0)
    and (actual_cost_micros is null or actual_cost_micros >= 0)
    and (latency_ms is null or latency_ms >= 0)
    and (quality_score is null or quality_score between 0 and 100)
  )
);

create index if not exists provider_routing_policies_workspace_stage_idx
  on public.provider_routing_policies(workspace_id, stage, updated_at desc, id desc);
create index if not exists provider_routing_routes_version_priority_idx
  on public.provider_routing_routes(policy_version_id, enabled, priority, id);
create index if not exists study_run_routing_bindings_workspace_idx
  on public.study_run_routing_bindings(workspace_id, bound_at desc, id desc);
create index if not exists provider_route_decisions_workspace_created_idx
  on public.provider_route_decisions(workspace_id, created_at desc, id desc);
create index if not exists provider_route_decisions_run_stage_idx
  on public.provider_route_decisions(run_id, stage, created_at desc, id desc);

create or replace function public.protect_collaboration_publication_identity()
returns trigger language plpgsql as $$
begin
  if new.publisher_workspace_id <> old.publisher_workspace_id
     or new.recipient_workspace_id <> old.recipient_workspace_id
     or new.created_by is distinct from old.created_by
     or new.artifact_type <> old.artifact_type
     or new.artifact_public_id <> old.artifact_public_id
     or new.artifact_version_public_id is distinct from old.artifact_version_public_id
     or new.artifact_hash <> old.artifact_hash
     or new.snapshot <> old.snapshot
     or new.capabilities <> old.capabilities
     or new.created_at <> old.created_at then
    raise exception 'COLLABORATION_PUBLICATION_SNAPSHOT_IMMUTABLE';
  end if;
  if old.status in ('rejected', 'revoked') and new.status <> old.status then
    raise exception 'COLLABORATION_PUBLICATION_TERMINAL';
  end if;
  return new;
end;
$$;

drop trigger if exists collaboration_publications_protect_identity on public.collaboration_publications;
create trigger collaboration_publications_protect_identity
before update on public.collaboration_publications
for each row execute function public.protect_collaboration_publication_identity();

create or replace function public.reject_run_routing_binding_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.study_runs run where run.id = old.run_id)
       or not exists (select 1 from public.workspaces workspace where workspace.id = old.workspace_id) then
      return old;
    end if;
  end if;
  raise exception 'RUN_ROUTING_BINDING_IMMUTABLE';
end;
$$;

drop trigger if exists study_run_routing_bindings_immutable on public.study_run_routing_bindings;
create trigger study_run_routing_bindings_immutable
before update or delete on public.study_run_routing_bindings
for each row execute function public.reject_run_routing_binding_mutation();

create or replace function public.protect_provider_route_decision_identity()
returns trigger language plpgsql as $$
begin
  if new.binding_id <> old.binding_id
     or new.run_id <> old.run_id
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

drop trigger if exists provider_route_decisions_protect_identity on public.provider_route_decisions;
create trigger provider_route_decisions_protect_identity
before update on public.provider_route_decisions
for each row execute function public.protect_provider_route_decision_identity();

alter table public.collaboration_publications enable row level security;
alter table public.collaboration_imports enable row level security;
alter table public.collaboration_delegations enable row level security;
alter table public.collaboration_events enable row level security;
alter table public.provider_routing_policies enable row level security;
alter table public.provider_routing_policy_versions enable row level security;
alter table public.provider_routing_routes enable row level security;
alter table public.study_run_routing_bindings enable row level security;
alter table public.provider_route_decisions enable row level security;

create policy collaboration_publications_select_party on public.collaboration_publications for select to authenticated
using (
  public.is_workspace_member(publisher_workspace_id)
  or (status <> 'draft' and public.is_workspace_member(recipient_workspace_id))
);
create policy collaboration_imports_select_member on public.collaboration_imports for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy collaboration_delegations_select_party on public.collaboration_delegations for select to authenticated
using (public.is_workspace_member(sender_workspace_id) or public.is_workspace_member(recipient_workspace_id));
create policy collaboration_events_select_party on public.collaboration_events for select to authenticated
using (
  exists (
    select 1 from public.collaboration_publications publication
    where publication.id = collaboration_events.publication_id
      and (public.is_workspace_member(publication.publisher_workspace_id)
        or public.is_workspace_member(publication.recipient_workspace_id))
  )
  or exists (
    select 1 from public.collaboration_delegations delegation
    where delegation.id = collaboration_events.delegation_id
      and (public.is_workspace_member(delegation.sender_workspace_id)
        or public.is_workspace_member(delegation.recipient_workspace_id))
  )
);
create policy provider_routing_policies_select_member on public.provider_routing_policies for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy provider_routing_policy_versions_select_member on public.provider_routing_policy_versions for select to authenticated
using (exists (
  select 1 from public.provider_routing_policies policy
  where policy.id = policy_id and public.is_workspace_member(policy.workspace_id)
));
create policy provider_routing_routes_select_member on public.provider_routing_routes for select to authenticated
using (exists (
  select 1 from public.provider_routing_policy_versions version
  join public.provider_routing_policies policy on policy.id = version.policy_id
  where version.id = policy_version_id and public.is_workspace_member(policy.workspace_id)
));
create policy study_run_routing_bindings_select_member on public.study_run_routing_bindings for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy provider_route_decisions_select_member on public.provider_route_decisions for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.collaboration_publications, public.collaboration_imports,
  public.collaboration_delegations, public.collaboration_events,
  public.provider_routing_policies, public.provider_routing_policy_versions,
  public.provider_routing_routes, public.study_run_routing_bindings,
  public.provider_route_decisions to authenticated;
