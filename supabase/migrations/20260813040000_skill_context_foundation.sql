-- Versioned contracts for the Skill Gateway and Context System.
-- This migration intentionally adds storage boundaries only; execution and retrieval
-- remain backwards-compatible with the existing research harness.

create table if not exists public.skill_manifests (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint references public.workspaces(id) on delete cascade,
  owner_user_id bigint references public.users(id) on delete set null,
  slug text not null,
  name text not null,
  description text not null default '',
  visibility text not null default 'workspace',
  status text not null default 'draft',
  latest_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug),
  constraint skill_manifests_visibility_check check (visibility in ('private', 'workspace', 'public')),
  constraint skill_manifests_status_check check (status in ('draft', 'active', 'archived'))
);

create table if not exists public.skill_versions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  skill_id bigint not null references public.skill_manifests(id) on delete cascade,
  version integer not null,
  manifest jsonb not null default '{}'::jsonb,
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  prompt_version text,
  artifact_uri text,
  checksum text,
  created_at timestamptz not null default now(),
  unique (skill_id, version),
  constraint skill_versions_version_check check (version > 0)
);

create table if not exists public.context_assets (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  asset_type text not null,
  scope text not null default 'workspace',
  title text not null,
  description text not null default '',
  source_uri text,
  current_version integer not null default 1,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint context_assets_scope_check check (scope in ('user', 'workspace', 'study', 'system')),
  constraint context_assets_status_check check (status in ('draft', 'active', 'archived'))
);

create table if not exists public.context_asset_versions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  asset_id bigint not null references public.context_assets(id) on delete cascade,
  version integer not null,
  content jsonb not null default '{}'::jsonb,
  change_note text not null default '',
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (asset_id, version),
  constraint context_asset_versions_version_check check (version > 0)
);

create table if not exists public.context_chunks (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  asset_version_id bigint not null references public.context_asset_versions(id) on delete cascade,
  ordinal integer not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding jsonb,
  created_at timestamptz not null default now(),
  unique (asset_version_id, ordinal),
  constraint context_chunks_ordinal_check check (ordinal >= 0),
  constraint context_chunks_content_check check (length(trim(content)) > 0)
);

create table if not exists public.context_edges (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  from_asset_id bigint not null references public.context_assets(id) on delete cascade,
  to_asset_id bigint not null references public.context_assets(id) on delete cascade,
  relation text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (from_asset_id, to_asset_id, relation),
  constraint context_edges_not_self check (from_asset_id <> to_asset_id)
);

create index if not exists skill_manifests_workspace_idx on public.skill_manifests(workspace_id, updated_at desc);
create index if not exists skill_versions_skill_idx on public.skill_versions(skill_id, version desc);
create index if not exists context_assets_workspace_idx on public.context_assets(workspace_id, updated_at desc);
create index if not exists context_asset_versions_asset_idx on public.context_asset_versions(asset_id, version desc);
create index if not exists context_chunks_asset_version_idx on public.context_chunks(asset_version_id, ordinal);
create index if not exists context_edges_workspace_idx on public.context_edges(workspace_id, relation);

alter table public.skill_manifests enable row level security;
alter table public.skill_versions enable row level security;
alter table public.context_assets enable row level security;
alter table public.context_asset_versions enable row level security;
alter table public.context_chunks enable row level security;
alter table public.context_edges enable row level security;

drop policy if exists skill_manifests_select_member on public.skill_manifests;
create policy skill_manifests_select_member on public.skill_manifests for select to authenticated
using (visibility = 'public' or public.is_workspace_member(workspace_id));

drop policy if exists skill_versions_select_member on public.skill_versions;
create policy skill_versions_select_member on public.skill_versions for select to authenticated
using (exists (select 1 from public.skill_manifests skill where skill.id = skill_id and (skill.visibility = 'public' or public.is_workspace_member(skill.workspace_id))));

drop policy if exists context_assets_select_member on public.context_assets;
create policy context_assets_select_member on public.context_assets for select to authenticated
using (scope = 'system' or public.is_workspace_member(workspace_id));

drop policy if exists context_asset_versions_select_member on public.context_asset_versions;
create policy context_asset_versions_select_member on public.context_asset_versions for select to authenticated
using (exists (select 1 from public.context_assets asset where asset.id = context_asset_versions.asset_id and (asset.scope = 'system' or public.is_workspace_member(asset.workspace_id))));

drop policy if exists context_chunks_select_member on public.context_chunks;
create policy context_chunks_select_member on public.context_chunks for select to authenticated
using (exists (select 1 from public.context_asset_versions asset_version join public.context_assets asset on asset.id = asset_version.asset_id where asset_version.id = context_chunks.asset_version_id and (asset.scope = 'system' or public.is_workspace_member(asset.workspace_id))));

drop policy if exists context_edges_select_member on public.context_edges;
create policy context_edges_select_member on public.context_edges for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.skill_manifests, public.skill_versions, public.context_assets,
  public.context_asset_versions, public.context_chunks, public.context_edges to authenticated;
