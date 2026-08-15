-- Purpose-bound Memory policies, evidence-linked behavior observations, and governed promotion.
create table if not exists public.context_memory_policies (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  memory_kind text not null,
  name text not null,
  version integer not null default 1,
  status text not null default 'active',
  allowed_purposes text[] not null default '{}',
  review_required boolean not null default true,
  default_retention_days integer,
  decay_days integer,
  promotion_min_observations integer not null default 2,
  conflict_strategy text not null default 'manual_review',
  created_by bigint references public.users(id) on delete set null,
  supersedes_policy_id bigint references public.context_memory_policies(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, memory_kind, version),
  constraint context_memory_policies_kind_check check (memory_kind in ('core', 'working', 'team')),
  constraint context_memory_policies_status_check check (status in ('active', 'superseded', 'disabled')),
  constraint context_memory_policies_version_check check (version > 0),
  constraint context_memory_policies_purposes_check check (
    allowed_purposes <@ array[
      'general', 'intent_planning', 'research_execution',
      'realtime_interview', 'report_generation', 'skill_execution'
    ]::text[]
  ),
  constraint context_memory_policies_retention_check check (default_retention_days is null or default_retention_days between 1 and 3650),
  constraint context_memory_policies_decay_check check (decay_days is null or decay_days between 1 and 3650),
  constraint context_memory_policies_promotion_check check (promotion_min_observations between 1 and 20),
  constraint context_memory_policies_conflict_check check (conflict_strategy in ('manual_review', 'keep_parallel', 'newest_verified'))
);

create unique index if not exists context_memory_policies_active_kind_idx
  on public.context_memory_policies(workspace_id, memory_kind) where status = 'active';
create index if not exists context_memory_policies_workspace_idx
  on public.context_memory_policies(workspace_id, status, memory_kind, version desc);

insert into public.context_memory_policies (
  public_id, workspace_id, memory_kind, name, version, allowed_purposes,
  review_required, default_retention_days, decay_days, promotion_min_observations,
  conflict_strategy
)
select 'cmp_core_' || md5(workspace.id::text || ':core'), workspace.id, 'core', 'Core Memory', 1,
       array['general', 'intent_planning', 'research_execution', 'report_generation']::text[],
       true, null, 365, 2, 'manual_review'
from public.workspaces workspace
on conflict (workspace_id, memory_kind, version) do nothing;

insert into public.context_memory_policies (
  public_id, workspace_id, memory_kind, name, version, allowed_purposes,
  review_required, default_retention_days, decay_days, promotion_min_observations,
  conflict_strategy
)
select 'cmp_working_' || md5(workspace.id::text || ':working'), workspace.id, 'working', 'Working Memory', 1,
       array['general', 'research_execution', 'realtime_interview', 'report_generation']::text[],
       true, 30, 30, 2, 'manual_review'
from public.workspaces workspace
on conflict (workspace_id, memory_kind, version) do nothing;

insert into public.context_memory_policies (
  public_id, workspace_id, memory_kind, name, version, allowed_purposes,
  review_required, default_retention_days, decay_days, promotion_min_observations,
  conflict_strategy
)
select 'cmp_team_' || md5(workspace.id::text || ':team'), workspace.id, 'team', 'Team Memory', 1,
       array['general', 'intent_planning', 'research_execution', 'report_generation', 'skill_execution']::text[],
       true, null, 730, 2, 'manual_review'
from public.workspaces workspace
on conflict (workspace_id, memory_kind, version) do nothing;

create table if not exists public.context_memory_bindings (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  asset_id bigint not null unique references public.context_assets(id) on delete cascade,
  policy_id bigint not null references public.context_memory_policies(id) on delete restrict,
  memory_kind text not null,
  subject_type text not null,
  subject_user_id bigint references public.users(id) on delete cascade,
  subject_public_id text,
  confidence text not null default 'low',
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  last_verified_at timestamptz,
  promotion_status text not null default 'none',
  source_observation_count integer not null default 0,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint context_memory_bindings_kind_check check (memory_kind in ('core', 'working', 'team')),
  constraint context_memory_bindings_subject_check check (subject_type in ('user', 'workspace', 'study', 'persona')),
  constraint context_memory_bindings_user_subject_check check (
    (subject_type = 'user' and subject_user_id is not null)
    or (subject_type <> 'user' and subject_user_id is null)
  ),
  constraint context_memory_bindings_confidence_check check (confidence in ('low', 'medium', 'high')),
  constraint context_memory_bindings_validity_check check (valid_until is null or valid_until > valid_from),
  constraint context_memory_bindings_promotion_check check (promotion_status in ('none', 'candidate', 'promoted', 'rejected')),
  constraint context_memory_bindings_observation_count_check check (source_observation_count >= 0)
);

create index if not exists context_memory_bindings_workspace_kind_idx
  on public.context_memory_bindings(workspace_id, memory_kind, valid_until);
create index if not exists context_memory_bindings_subject_idx
  on public.context_memory_bindings(subject_type, subject_user_id, subject_public_id);
create index if not exists context_memory_bindings_policy_idx
  on public.context_memory_bindings(policy_id);

create table if not exists public.context_behavior_observations (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  memory_asset_id bigint not null references public.context_assets(id) on delete cascade,
  source_asset_id bigint references public.context_assets(id) on delete restrict,
  evidence_item_id bigint references public.evidence_items(id) on delete restrict,
  observation_type text not null,
  statement text not null,
  evidence_kind text not null,
  confidence text not null default 'low',
  observed_at timestamptz not null,
  valid_until timestamptz,
  status text not null default 'pending',
  content_hash text not null,
  created_by bigint references public.users(id) on delete set null,
  reviewed_by bigint references public.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (memory_asset_id, content_hash),
  constraint context_behavior_observations_source_check check (source_asset_id is not null or evidence_item_id is not null),
  constraint context_behavior_observations_not_self_check check (source_asset_id is null or source_asset_id <> memory_asset_id),
  constraint context_behavior_observations_type_check check (observation_type in ('preference', 'habit', 'constraint', 'decision_signal')),
  constraint context_behavior_observations_evidence_check check (evidence_kind in ('human_observation', 'public_source', 'synthetic_simulation', 'model_inference')),
  constraint context_behavior_observations_confidence_check check (confidence in ('low', 'medium', 'high')),
  constraint context_behavior_observations_status_check check (status in ('pending', 'approved', 'rejected')),
  constraint context_behavior_observations_statement_check check (length(trim(statement)) between 2 and 2000),
  constraint context_behavior_observations_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint context_behavior_observations_validity_check check (valid_until is null or valid_until > observed_at)
);

create index if not exists context_behavior_observations_memory_idx
  on public.context_behavior_observations(memory_asset_id, status, observed_at desc);
create index if not exists context_behavior_observations_source_idx
  on public.context_behavior_observations(source_asset_id, created_at desc);
create index if not exists context_behavior_observations_evidence_idx
  on public.context_behavior_observations(evidence_item_id) where evidence_item_id is not null;

create table if not exists public.context_memory_events (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  asset_id bigint references public.context_assets(id) on delete cascade,
  policy_id bigint references public.context_memory_policies(id) on delete cascade,
  observation_id bigint references public.context_behavior_observations(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists context_memory_events_asset_idx
  on public.context_memory_events(asset_id, created_at desc);
create index if not exists context_memory_events_workspace_idx
  on public.context_memory_events(workspace_id, created_at desc);
create index if not exists context_memory_events_policy_idx
  on public.context_memory_events(policy_id, created_at desc) where policy_id is not null;

alter table public.context_retrievals
  add column if not exists purpose text not null default 'general',
  add column if not exists policy_version text not null default 'memory-policy-v1',
  add column if not exists policy_decision jsonb not null default '{}'::jsonb;

alter table public.context_retrievals
  drop constraint if exists context_retrievals_purpose_check,
  add constraint context_retrievals_purpose_check check (
    purpose in ('general', 'intent_planning', 'research_execution', 'realtime_interview', 'report_generation', 'skill_execution')
  ),
  drop constraint if exists context_retrievals_policy_decision_check,
  add constraint context_retrievals_policy_decision_check check (jsonb_typeof(policy_decision) = 'object');

alter table public.context_memory_policies enable row level security;
alter table public.context_memory_bindings enable row level security;
alter table public.context_behavior_observations enable row level security;
alter table public.context_memory_events enable row level security;

drop policy if exists context_memory_policies_select_member on public.context_memory_policies;
create policy context_memory_policies_select_member on public.context_memory_policies for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists context_memory_bindings_select_visible on public.context_memory_bindings;
create policy context_memory_bindings_select_visible on public.context_memory_bindings for select to authenticated
using (exists (
  select 1 from public.context_assets asset
  where asset.id = context_memory_bindings.asset_id
    and public.is_workspace_member(asset.workspace_id)
    and (
      asset.scope <> 'user'
      or exists (select 1 from public.users app_user where app_user.id = asset.created_by and app_user.auth_user_id = (select auth.uid()))
    )
));

drop policy if exists context_behavior_observations_select_visible on public.context_behavior_observations;
create policy context_behavior_observations_select_visible on public.context_behavior_observations for select to authenticated
using (exists (
  select 1 from public.context_assets asset
  where asset.id = context_behavior_observations.memory_asset_id
    and public.is_workspace_member(asset.workspace_id)
    and (
      asset.scope <> 'user'
      or exists (select 1 from public.users app_user where app_user.id = asset.created_by and app_user.auth_user_id = (select auth.uid()))
    )
));

drop policy if exists context_memory_events_select_visible on public.context_memory_events;
create policy context_memory_events_select_visible on public.context_memory_events for select to authenticated
using (
  public.is_workspace_member(workspace_id)
  and (
    asset_id is null
    or exists (
      select 1 from public.context_assets asset
      where asset.id = context_memory_events.asset_id
        and (
          asset.scope <> 'user'
          or exists (select 1 from public.users app_user where app_user.id = asset.created_by and app_user.auth_user_id = (select auth.uid()))
        )
    )
  )
);

grant select on public.context_memory_policies, public.context_memory_bindings,
  public.context_behavior_observations, public.context_memory_events to authenticated;
