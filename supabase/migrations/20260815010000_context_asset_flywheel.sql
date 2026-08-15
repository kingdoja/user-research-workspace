-- Governed Context ingestion, review lifecycle, provenance graph, and audit events.
alter table public.context_asset_versions
  add column if not exists content_hash text;

update public.context_asset_versions
set content_hash = encode(digest(content::text, 'sha256'), 'hex')
where content_hash is null;

alter table public.context_asset_versions
  alter column content_hash set not null,
  drop constraint if exists context_asset_versions_content_hash_check,
  add constraint context_asset_versions_content_hash_check
    check (content_hash ~ '^[0-9a-f]{64}$');

alter table public.context_assets
  add column if not exists ingestion_method text not null default 'manual',
  add column if not exists source_name text,
  add column if not exists source_mime_type text,
  add column if not exists source_hash text,
  add column if not exists evidence_kind text not null default 'not_applicable',
  add column if not exists consent_status text not null default 'not_required',
  add column if not exists pii_status text not null default 'not_reviewed',
  add column if not exists retention_expires_at timestamptz,
  add column if not exists review_status text not null default 'approved',
  add column if not exists reviewed_by bigint references public.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text,
  add column if not exists origin_kind text,
  add column if not exists origin_public_id text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.context_assets asset
set source_hash = version.content_hash
from public.context_asset_versions version
where version.asset_id = asset.id
  and version.version = asset.current_version
  and asset.source_hash is null;

alter table public.context_assets
  alter column source_hash set not null,
  drop constraint if exists context_assets_ingestion_method_check,
  add constraint context_assets_ingestion_method_check
    check (ingestion_method in ('manual', 'file', 'study_output', 'interview_output', 'system')),
  drop constraint if exists context_assets_evidence_kind_check,
  add constraint context_assets_evidence_kind_check
    check (evidence_kind in ('human', 'synthetic', 'mixed', 'not_applicable')),
  drop constraint if exists context_assets_consent_status_check,
  add constraint context_assets_consent_status_check
    check (consent_status in ('confirmed', 'restricted', 'unknown', 'not_required')),
  drop constraint if exists context_assets_pii_status_check,
  add constraint context_assets_pii_status_check
    check (pii_status in ('none', 'present', 'redacted', 'not_reviewed')),
  drop constraint if exists context_assets_review_status_check,
  add constraint context_assets_review_status_check
    check (review_status in ('pending', 'approved', 'rejected')),
  drop constraint if exists context_assets_source_hash_check,
  add constraint context_assets_source_hash_check
    check (source_hash ~ '^[0-9a-f]{64}$'),
  drop constraint if exists context_assets_origin_pair_check,
  add constraint context_assets_origin_pair_check
    check ((origin_kind is null) = (origin_public_id is null));

alter table public.context_edges
  add column if not exists created_by bigint references public.users(id) on delete set null;

alter table public.context_edges
  drop constraint if exists context_edges_relation_check,
  add constraint context_edges_relation_check
    check (relation in ('derived_from', 'supports', 'contradicts', 'mentions', 'supersedes', 'related_to'));

create unique index if not exists context_assets_origin_unique_idx
  on public.context_assets(workspace_id, origin_kind, origin_public_id, asset_type)
  where origin_kind is not null and origin_public_id is not null and status <> 'tombstoned';
create index if not exists context_assets_review_queue_idx
  on public.context_assets(workspace_id, review_status, updated_at desc);
create index if not exists context_assets_retention_idx
  on public.context_assets(workspace_id, retention_expires_at)
  where retention_expires_at is not null and status <> 'tombstoned';

create table if not exists public.context_asset_events (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  asset_id bigint not null references public.context_assets(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists context_asset_events_asset_created_idx
  on public.context_asset_events(asset_id, created_at desc);
create index if not exists context_asset_events_workspace_created_idx
  on public.context_asset_events(workspace_id, created_at desc);

alter table public.context_asset_events enable row level security;

drop policy if exists context_asset_events_select_member on public.context_asset_events;
create policy context_asset_events_select_member on public.context_asset_events for select to authenticated
using (public.is_workspace_member(workspace_id));
