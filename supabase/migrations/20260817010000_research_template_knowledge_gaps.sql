-- Governed research-template and knowledge-gap candidates.
alter table public.context_assets
  add column if not exists candidate_dedupe_key text,
  add column if not exists expiry_policy text not null default 'none';

alter table public.context_assets
  drop constraint if exists context_assets_candidate_dedupe_key_check,
  add constraint context_assets_candidate_dedupe_key_check
    check (candidate_dedupe_key is null or candidate_dedupe_key ~ '^[0-9a-f]{64}$'),
  drop constraint if exists context_assets_expiry_policy_check,
  add constraint context_assets_expiry_policy_check
    check (expiry_policy in ('none', 'exclude_on_expiry')),
  drop constraint if exists context_assets_candidate_governance_check,
  add constraint context_assets_candidate_governance_check check (
    asset_type not in ('research_template', 'knowledge_gap')
    or (
      candidate_dedupe_key is not null
      and expiry_policy = 'exclude_on_expiry'
      and retention_expires_at is not null
      and ingestion_method = 'study_output'
    )
  );

create unique index if not exists context_assets_candidate_dedupe_unique_idx
  on public.context_assets(workspace_id, asset_type, candidate_dedupe_key)
  where candidate_dedupe_key is not null and status in ('draft', 'active');

create index if not exists context_assets_candidate_expiry_idx
  on public.context_assets(workspace_id, asset_type, retention_expires_at, review_status)
  where asset_type in ('research_template', 'knowledge_gap') and status <> 'tombstoned';

alter table public.context_edges
  drop constraint if exists context_edges_relation_check,
  add constraint context_edges_relation_check
    check (relation in (
      'derived_from', 'supports', 'contradicts', 'mentions', 'supersedes',
      'related_to', 'resolved_by'
    ));
