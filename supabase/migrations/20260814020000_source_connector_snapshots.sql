-- Auditable public-source connector runs, candidates, immutable snapshots and observations.
create table if not exists public.source_connector_runs (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint not null references public.study_runs(id) on delete cascade,
  task_key text not null,
  attempt integer not null default 1,
  connector_key text not null,
  provider text not null,
  policy_version text not null,
  status text not null default 'running',
  query_plan jsonb not null default '[]'::jsonb,
  candidate_count integer not null default 0,
  collected_count integer not null default 0,
  rejected_count integer not null default 0,
  unavailable_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, task_key, attempt),
  constraint source_connector_runs_attempt_check check (attempt > 0),
  constraint source_connector_runs_status_check check (status in ('running', 'completed', 'partial', 'failed', 'cancelled')),
  constraint source_connector_runs_query_plan_check check (jsonb_typeof(query_plan) = 'array'),
  constraint source_connector_runs_counts_check check (
    candidate_count >= 0 and collected_count >= 0 and rejected_count >= 0 and unavailable_count >= 0
  )
);

create table if not exists public.source_candidates (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  connector_run_id bigint not null references public.source_connector_runs(id) on delete cascade,
  provider text not null,
  query text,
  provider_rank integer,
  provider_score double precision,
  title text not null,
  source_url text not null,
  canonical_url text not null,
  status text not null default 'discovered',
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now(),
  collected_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (connector_run_id, canonical_url),
  constraint source_candidates_rank_check check (provider_rank is null or provider_rank > 0),
  constraint source_candidates_status_check check (status in ('discovered', 'collected', 'rejected', 'unavailable', 'removed')),
  constraint source_candidates_title_check check (length(trim(title)) > 0),
  constraint source_candidates_url_check check (length(trim(source_url)) > 0 and length(trim(canonical_url)) > 0)
);

create table if not exists public.source_snapshots (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  candidate_id bigint not null references public.source_candidates(id) on delete cascade,
  status text not null,
  canonical_url text not null,
  http_status integer,
  content_type text,
  content_length integer,
  etag text,
  last_modified text,
  content_hash text,
  raw_content text,
  normalized_text text,
  fetched_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (candidate_id, public_id),
  constraint source_snapshots_status_check check (status in ('available', 'unavailable', 'removed')),
  constraint source_snapshots_http_status_check check (http_status is null or http_status between 100 and 599),
  constraint source_snapshots_content_length_check check (content_length is null or content_length >= 0),
  constraint source_snapshots_available_content_check check (
    status <> 'available' or (
      content_hash is not null and raw_content is not null and normalized_text is not null
      and length(trim(normalized_text)) > 0
    )
  )
);

create table if not exists public.source_observations (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  candidate_id bigint not null references public.source_candidates(id) on delete cascade,
  snapshot_id bigint not null references public.source_snapshots(id) on delete cascade,
  observation_key text not null,
  observation_kind text not null,
  content text not null,
  confidence text not null default 'medium',
  locator jsonb not null default '{}'::jsonb,
  coding jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (snapshot_id, observation_key),
  constraint source_observations_kind_check check (observation_kind in ('page_excerpt', 'search_excerpt', 'document_text')),
  constraint source_observations_confidence_check check (confidence in ('low', 'medium', 'high')),
  constraint source_observations_content_check check (length(trim(content)) > 0)
);

create index if not exists source_connector_runs_study_created_idx
  on public.source_connector_runs(study_id, created_at, id);
create index if not exists source_connector_runs_run_task_idx
  on public.source_connector_runs(run_id, task_key, attempt);
create index if not exists source_candidates_run_status_idx
  on public.source_candidates(connector_run_id, status, id);
create index if not exists source_candidates_canonical_url_idx
  on public.source_candidates(canonical_url);
create index if not exists source_snapshots_candidate_fetched_idx
  on public.source_snapshots(candidate_id, fetched_at, id);
create index if not exists source_snapshots_content_hash_idx
  on public.source_snapshots(content_hash) where content_hash is not null;
create index if not exists source_observations_snapshot_idx
  on public.source_observations(snapshot_id, id);

create or replace function public.reject_source_snapshot_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'source snapshots are immutable';
end;
$$;

drop trigger if exists source_snapshots_immutable on public.source_snapshots;
create trigger source_snapshots_immutable
  before update on public.source_snapshots
  for each row execute function public.reject_source_snapshot_update();

drop trigger if exists source_observations_immutable on public.source_observations;
create trigger source_observations_immutable
  before update on public.source_observations
  for each row execute function public.reject_source_snapshot_update();

alter table public.source_connector_runs enable row level security;
alter table public.source_candidates enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.source_observations enable row level security;

create policy source_connector_runs_select_member on public.source_connector_runs for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy source_candidates_select_member on public.source_candidates for select to authenticated
using (exists (
  select 1 from public.source_connector_runs connector_run
  where connector_run.id = connector_run_id and public.is_workspace_member(connector_run.workspace_id)
));
create policy source_snapshots_select_member on public.source_snapshots for select to authenticated
using (exists (
  select 1 from public.source_candidates candidate
  join public.source_connector_runs connector_run on connector_run.id = candidate.connector_run_id
  where candidate.id = candidate_id and public.is_workspace_member(connector_run.workspace_id)
));
create policy source_observations_select_member on public.source_observations for select to authenticated
using (exists (
  select 1 from public.source_candidates candidate
  join public.source_connector_runs connector_run on connector_run.id = candidate.connector_run_id
  where candidate.id = candidate_id and public.is_workspace_member(connector_run.workspace_id)
));

grant select on public.source_connector_runs, public.source_candidates,
  public.source_snapshots, public.source_observations to authenticated;
