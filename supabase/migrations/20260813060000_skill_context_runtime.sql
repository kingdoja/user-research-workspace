-- Runtime bindings and auditable retrieval snapshots for Skill and Context contracts.
alter table public.study_tool_invocations
  add column if not exists skill_slug text,
  add column if not exists skill_version integer,
  add column if not exists context_retrieval_id bigint;

alter table public.context_assets
  add column if not exists study_id bigint references public.studies(id) on delete cascade;

alter table public.context_assets
  drop constraint if exists context_assets_study_scope_check,
  add constraint context_assets_study_scope_check check (
    (scope = 'study' and study_id is not null)
    or (scope <> 'study' and study_id is null)
  );

create table if not exists public.skill_events (
  id bigint generated always as identity primary key,
  skill_id bigint not null references public.skill_manifests(id) on delete cascade,
  workspace_id bigint references public.workspaces(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.context_retrievals (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  study_id bigint references public.studies(id) on delete cascade,
  run_id bigint references public.study_runs(id) on delete cascade,
  query text not null,
  strategy text not null default 'lexical_metadata_v1',
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint context_retrievals_query_check check (length(trim(query)) > 0)
);

create table if not exists public.context_retrieval_items (
  retrieval_id bigint not null references public.context_retrievals(id) on delete cascade,
  chunk_id bigint not null references public.context_chunks(id) on delete cascade,
  rank integer not null,
  score double precision not null,
  reasons jsonb not null default '[]'::jsonb,
  primary key (retrieval_id, chunk_id),
  unique (retrieval_id, rank),
  constraint context_retrieval_items_rank_check check (rank > 0),
  constraint context_retrieval_items_score_check check (score >= 0)
);

alter table public.study_tool_invocations
  drop constraint if exists study_tool_invocations_context_retrieval_id_fkey,
  add constraint study_tool_invocations_context_retrieval_id_fkey
    foreign key (context_retrieval_id) references public.context_retrievals(id) on delete set null;

create index if not exists study_tool_invocations_skill_idx
  on public.study_tool_invocations(skill_slug, skill_version, started_at desc);
create index if not exists skill_events_skill_created_idx on public.skill_events(skill_id, created_at desc);
create index if not exists context_retrievals_workspace_created_idx on public.context_retrievals(workspace_id, created_at desc);
create index if not exists context_retrievals_run_idx on public.context_retrievals(run_id, created_at desc);
create unique index if not exists context_retrievals_one_per_run_idx
  on public.context_retrievals(run_id) where run_id is not null;
create index if not exists context_assets_study_idx on public.context_assets(study_id, updated_at desc);
create index if not exists context_retrieval_items_retrieval_rank_idx on public.context_retrieval_items(retrieval_id, rank);

alter table public.skill_events enable row level security;
alter table public.context_retrievals enable row level security;
alter table public.context_retrieval_items enable row level security;

drop policy if exists skill_manifests_select_member on public.skill_manifests;
create policy skill_manifests_select_member on public.skill_manifests for select to authenticated
using (
  visibility = 'public'
  or (
    public.is_workspace_member(workspace_id)
    and (
      visibility = 'workspace'
      or exists (select 1 from public.users app_user where app_user.id = owner_user_id and app_user.auth_user_id = auth.uid())
    )
  )
);

drop policy if exists skill_versions_select_member on public.skill_versions;
create policy skill_versions_select_member on public.skill_versions for select to authenticated
using (exists (
  select 1 from public.skill_manifests skill
  where skill.id = skill_id
    and (
      skill.visibility = 'public'
      or (
        public.is_workspace_member(skill.workspace_id)
        and (
          skill.visibility = 'workspace'
          or exists (select 1 from public.users app_user where app_user.id = skill.owner_user_id and app_user.auth_user_id = auth.uid())
        )
      )
    )
));

drop policy if exists context_assets_select_member on public.context_assets;
create policy context_assets_select_member on public.context_assets for select to authenticated
using (
  public.is_workspace_member(workspace_id)
  and (
    scope <> 'user'
    or exists (select 1 from public.users app_user where app_user.id = created_by and app_user.auth_user_id = auth.uid())
  )
);

drop policy if exists context_asset_versions_select_member on public.context_asset_versions;
create policy context_asset_versions_select_member on public.context_asset_versions for select to authenticated
using (exists (
  select 1 from public.context_assets asset
  where asset.id = context_asset_versions.asset_id
    and public.is_workspace_member(asset.workspace_id)
    and (
      asset.scope <> 'user'
      or exists (select 1 from public.users app_user where app_user.id = asset.created_by and app_user.auth_user_id = auth.uid())
    )
));

drop policy if exists context_chunks_select_member on public.context_chunks;
create policy context_chunks_select_member on public.context_chunks for select to authenticated
using (exists (
  select 1
  from public.context_asset_versions asset_version
  join public.context_assets asset on asset.id = asset_version.asset_id
  where asset_version.id = context_chunks.asset_version_id
    and public.is_workspace_member(asset.workspace_id)
    and (
      asset.scope <> 'user'
      or exists (select 1 from public.users app_user where app_user.id = asset.created_by and app_user.auth_user_id = auth.uid())
    )
));

drop policy if exists context_edges_select_member on public.context_edges;
create policy context_edges_select_member on public.context_edges for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists skill_events_select_member on public.skill_events;
create policy skill_events_select_member on public.skill_events for select to authenticated
using (workspace_id is not null and public.is_workspace_member(workspace_id));

drop policy if exists context_retrievals_select_member on public.context_retrievals;
create policy context_retrievals_select_member on public.context_retrievals for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists context_retrieval_items_select_member on public.context_retrieval_items;
create policy context_retrieval_items_select_member on public.context_retrieval_items for select to authenticated
using (exists (
  select 1 from public.context_retrievals retrieval
  where retrieval.id = retrieval_id and public.is_workspace_member(retrieval.workspace_id)
));

grant select on public.skill_events, public.context_retrievals, public.context_retrieval_items to authenticated;
