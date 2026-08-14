-- Auditable hybrid retrieval, offline evaluation datasets, and context lifecycle controls.
alter table public.context_assets
  add column if not exists index_generation integer not null default 1,
  add column if not exists tombstoned_at timestamptz,
  add column if not exists tombstone_reason text;

alter table public.context_assets
  drop constraint if exists context_assets_status_check,
  add constraint context_assets_status_check check (status in ('draft', 'active', 'archived', 'tombstoned')),
  drop constraint if exists context_assets_index_generation_check,
  add constraint context_assets_index_generation_check check (index_generation >= 1),
  drop constraint if exists context_assets_tombstone_check,
  add constraint context_assets_tombstone_check check (
    (status = 'tombstoned' and tombstoned_at is not null and length(trim(coalesce(tombstone_reason, ''))) > 0)
    or (status <> 'tombstoned' and tombstoned_at is null)
  );

alter table public.context_chunks
  add column if not exists search_vector tsvector generated always as (to_tsvector('simple', content)) stored,
  add column if not exists embedding_model text,
  add column if not exists embedding_dimensions integer,
  add column if not exists embedding_indexed_at timestamptz,
  add column if not exists index_generation integer not null default 1;

alter table public.context_chunks
  drop constraint if exists context_chunks_embedding_dimensions_check,
  add constraint context_chunks_embedding_dimensions_check check (embedding_dimensions is null or embedding_dimensions between 8 and 4096),
  drop constraint if exists context_chunks_index_generation_check,
  add constraint context_chunks_index_generation_check check (index_generation >= 1);

create index if not exists context_chunks_search_vector_idx
  on public.context_chunks using gin(search_vector);
create index if not exists context_assets_active_workspace_idx
  on public.context_assets(workspace_id, updated_at desc, id)
  where status = 'active';

alter table public.context_retrievals
  add column if not exists embedding_model text,
  add column if not exists embedding_version text,
  add column if not exists lexical_weight double precision,
  add column if not exists semantic_weight double precision;

alter table public.context_retrievals
  drop constraint if exists context_retrievals_weights_check,
  add constraint context_retrievals_weights_check check (
    (lexical_weight is null and semantic_weight is null)
    or (lexical_weight between 0 and 1 and semantic_weight between 0 and 1 and abs(lexical_weight + semantic_weight - 1) < 0.000001)
  );

create table if not exists public.context_reindex_runs (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  asset_id bigint not null references public.context_assets(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  generation integer not null,
  status text not null default 'running',
  embedding_model text not null,
  embedding_version text not null,
  chunk_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint context_reindex_runs_generation_check check (generation >= 1),
  constraint context_reindex_runs_chunk_count_check check (chunk_count >= 0),
  constraint context_reindex_runs_status_check check (status in ('running', 'completed', 'failed')),
  unique (asset_id, generation)
);

create index if not exists context_reindex_runs_workspace_started_idx
  on public.context_reindex_runs(workspace_id, started_at desc);
create index if not exists context_reindex_runs_asset_generation_idx
  on public.context_reindex_runs(asset_id, generation desc);

create table if not exists public.context_evaluation_sets (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  name text not null,
  description text not null default '',
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint context_evaluation_sets_status_check check (status in ('draft', 'active', 'archived'))
);

create table if not exists public.context_evaluation_cases (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  evaluation_set_id bigint not null references public.context_evaluation_sets(id) on delete cascade,
  query text not null,
  filters jsonb not null default '{}'::jsonb,
  top_k integer not null default 8,
  created_at timestamptz not null default now(),
  constraint context_evaluation_cases_query_check check (length(trim(query)) > 0),
  constraint context_evaluation_cases_top_k_check check (top_k between 1 and 20),
  constraint context_evaluation_cases_filters_check check (jsonb_typeof(filters) = 'object')
);

create table if not exists public.context_evaluation_relevance (
  evaluation_case_id bigint not null references public.context_evaluation_cases(id) on delete cascade,
  chunk_id bigint not null references public.context_chunks(id) on delete cascade,
  relevance smallint not null default 1,
  created_at timestamptz not null default now(),
  primary key (evaluation_case_id, chunk_id),
  constraint context_evaluation_relevance_score_check check (relevance between 1 and 3)
);

create table if not exists public.context_evaluation_runs (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  evaluation_set_id bigint not null references public.context_evaluation_sets(id) on delete cascade,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint references public.users(id) on delete set null,
  strategy text not null,
  embedding_model text,
  embedding_version text,
  status text not null default 'running',
  case_count integer not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint context_evaluation_runs_status_check check (status in ('running', 'completed', 'failed')),
  constraint context_evaluation_runs_case_count_check check (case_count >= 0),
  constraint context_evaluation_runs_metrics_check check (jsonb_typeof(metrics) = 'object')
);

create table if not exists public.context_evaluation_results (
  evaluation_run_id bigint not null references public.context_evaluation_runs(id) on delete cascade,
  evaluation_case_id bigint not null references public.context_evaluation_cases(id) on delete cascade,
  retrieved_chunk_ids jsonb not null default '[]'::jsonb,
  expected_chunk_ids jsonb not null default '[]'::jsonb,
  precision_at_k double precision not null,
  recall_at_k double precision not null,
  reciprocal_rank double precision not null,
  created_at timestamptz not null default now(),
  primary key (evaluation_run_id, evaluation_case_id),
  constraint context_evaluation_results_arrays_check check (
    jsonb_typeof(retrieved_chunk_ids) = 'array' and jsonb_typeof(expected_chunk_ids) = 'array'
  ),
  constraint context_evaluation_results_scores_check check (
    precision_at_k between 0 and 1 and recall_at_k between 0 and 1 and reciprocal_rank between 0 and 1
  )
);

create index if not exists context_evaluation_sets_workspace_idx
  on public.context_evaluation_sets(workspace_id, updated_at desc);
create index if not exists context_evaluation_cases_set_idx
  on public.context_evaluation_cases(evaluation_set_id, id);
create index if not exists context_evaluation_relevance_chunk_idx
  on public.context_evaluation_relevance(chunk_id, evaluation_case_id);
create index if not exists context_evaluation_runs_workspace_idx
  on public.context_evaluation_runs(workspace_id, started_at desc);
create index if not exists context_evaluation_results_case_idx
  on public.context_evaluation_results(evaluation_case_id, evaluation_run_id);

alter table public.context_reindex_runs enable row level security;
alter table public.context_evaluation_sets enable row level security;
alter table public.context_evaluation_cases enable row level security;
alter table public.context_evaluation_relevance enable row level security;
alter table public.context_evaluation_runs enable row level security;
alter table public.context_evaluation_results enable row level security;

create policy context_reindex_runs_select_member on public.context_reindex_runs for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy context_evaluation_sets_select_member on public.context_evaluation_sets for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy context_evaluation_cases_select_member on public.context_evaluation_cases for select to authenticated
using (exists (
  select 1 from public.context_evaluation_sets evaluation_set
  where evaluation_set.id = evaluation_set_id and public.is_workspace_member(evaluation_set.workspace_id)
));
create policy context_evaluation_relevance_select_member on public.context_evaluation_relevance for select to authenticated
using (exists (
  select 1 from public.context_evaluation_cases evaluation_case
  join public.context_evaluation_sets evaluation_set on evaluation_set.id = evaluation_case.evaluation_set_id
  where evaluation_case.id = evaluation_case_id and public.is_workspace_member(evaluation_set.workspace_id)
));
create policy context_evaluation_runs_select_member on public.context_evaluation_runs for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy context_evaluation_results_select_member on public.context_evaluation_results for select to authenticated
using (exists (
  select 1 from public.context_evaluation_runs evaluation_run
  where evaluation_run.id = evaluation_run_id and public.is_workspace_member(evaluation_run.workspace_id)
));

grant select on public.context_reindex_runs, public.context_evaluation_sets,
  public.context_evaluation_cases, public.context_evaluation_relevance,
  public.context_evaluation_runs, public.context_evaluation_results to authenticated;
