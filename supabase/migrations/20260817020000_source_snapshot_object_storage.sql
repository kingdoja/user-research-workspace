-- Large immutable source bodies live in content-addressed S3-compatible object storage.
alter table public.source_snapshots
  add column if not exists raw_storage_provider text,
  add column if not exists raw_storage_bucket text,
  add column if not exists raw_storage_key text,
  add column if not exists raw_storage_version_id text,
  add column if not exists raw_storage_etag text,
  add column if not exists raw_byte_length bigint;

alter table public.source_snapshots
  drop constraint if exists source_snapshots_available_content_check,
  add constraint source_snapshots_available_content_check check (
    status <> 'available' or (
      content_hash is not null
      and normalized_text is not null
      and (
        (raw_content is not null and raw_storage_provider is null and raw_storage_bucket is null and raw_storage_key is null)
        or
        (raw_content is null and raw_storage_provider = 's3' and raw_storage_bucket is not null and raw_storage_key is not null and raw_byte_length >= 0)
      )
    )
  ),
  add constraint source_snapshots_raw_storage_provider_check check (
    raw_storage_provider is null or raw_storage_provider = 's3'
  ),
  add constraint source_snapshots_raw_storage_locator_check check (
    (
      raw_storage_provider is null
      and raw_storage_bucket is null
      and raw_storage_key is null
      and raw_storage_version_id is null
      and raw_storage_etag is null
    )
    or
    (
      raw_storage_provider = 's3'
      and raw_storage_bucket is not null
      and raw_storage_key is not null
      and raw_content is null
      and raw_byte_length >= 0
    )
  ),
  add constraint source_snapshots_raw_byte_length_check check (
    raw_byte_length is null or raw_byte_length >= 0
  );

create index if not exists source_snapshots_raw_storage_key_idx
  on public.source_snapshots(raw_storage_bucket, raw_storage_key)
  where raw_storage_key is not null;

alter table public.source_observations
  drop constraint if exists source_observations_kind_check,
  add constraint source_observations_kind_check check (
    observation_kind in ('page_excerpt', 'search_excerpt', 'document_text', 'social_post')
  );
