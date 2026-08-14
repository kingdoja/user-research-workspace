-- Versioned evidence, claim, and report-node graph for auditable research outputs.
create table if not exists public.evidence_sources (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint references public.study_runs(id) on delete set null,
  source_type text not null,
  title text not null,
  source_uri text,
  source_locator jsonb not null default '{}'::jsonb,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  collected_at timestamptz,
  created_at timestamptz not null default now(),
  unique (study_id, run_id, source_type, content_hash),
  constraint evidence_sources_type_check check (
    source_type in ('public_web', 'context_asset', 'interview_session', 'synthetic_interview', 'discussion', 'calculation', 'user_input')
  ),
  constraint evidence_sources_title_check check (length(trim(title)) > 0)
);

create table if not exists public.evidence_items (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  source_id bigint not null references public.evidence_sources(id) on delete cascade,
  item_key text not null,
  evidence_type text not null,
  content text not null,
  locator jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, item_key),
  constraint evidence_items_type_check check (
    evidence_type in ('fact', 'human_observation', 'synthetic_simulation', 'model_inference', 'calculation')
  ),
  constraint evidence_items_content_check check (length(trim(content)) > 0)
);

create table if not exists public.claims (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint references public.study_runs(id) on delete set null,
  claim_key text not null,
  statement text not null,
  claim_type text not null,
  confidence text not null,
  support_status text not null,
  rationale text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (study_id, run_id, claim_key),
  constraint claims_type_check check (
    claim_type in ('fact', 'human_observation', 'synthetic_simulation', 'model_inference', 'recommendation')
  ),
  constraint claims_confidence_check check (confidence in ('low', 'medium', 'high')),
  constraint claims_support_check check (support_status in ('supported', 'mixed', 'unsupported')),
  constraint claims_statement_check check (length(trim(statement)) > 0)
);

create table if not exists public.claim_evidence (
  claim_id bigint not null references public.claims(id) on delete cascade,
  evidence_item_id bigint not null references public.evidence_items(id) on delete cascade,
  stance text not null default 'supports',
  strength text not null default 'medium',
  rationale text not null default '',
  created_at timestamptz not null default now(),
  primary key (claim_id, evidence_item_id),
  constraint claim_evidence_stance_check check (stance in ('supports', 'refutes', 'context')),
  constraint claim_evidence_strength_check check (strength in ('low', 'medium', 'high'))
);

create table if not exists public.report_versions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  report_id bigint not null references public.reports(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  run_id bigint references public.study_runs(id) on delete set null,
  version integer not null,
  status text not null default 'published',
  content_json jsonb not null default '{}'::jsonb,
  provider text,
  provider_model text,
  provider_response_id text,
  prompt_version text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (report_id, version),
  unique (report_id, run_id),
  constraint report_versions_version_check check (version > 0),
  constraint report_versions_status_check check (status in ('draft', 'published', 'superseded'))
);

create table if not exists public.report_nodes (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  report_version_id bigint not null references public.report_versions(id) on delete cascade,
  claim_id bigint references public.claims(id) on delete set null,
  node_key text not null,
  node_type text not null,
  position integer not null,
  title text not null default '',
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (report_version_id, node_key),
  unique (report_version_id, position),
  constraint report_nodes_type_check check (
    node_type in ('summary', 'finding', 'recommendation', 'limitation', 'next_question')
  ),
  constraint report_nodes_position_check check (position >= 0)
);

alter table public.reports add column if not exists current_version_id bigint;
alter table public.reports
  drop constraint if exists reports_current_version_id_fkey,
  add constraint reports_current_version_id_fkey
    foreign key (current_version_id) references public.report_versions(id) on delete set null;

create index if not exists evidence_sources_study_run_idx on public.evidence_sources(study_id, run_id, created_at);
create index if not exists evidence_items_source_idx on public.evidence_items(source_id, created_at);
create index if not exists claims_study_run_idx on public.claims(study_id, run_id, created_at);
create index if not exists claim_evidence_item_idx on public.claim_evidence(evidence_item_id, claim_id);
create index if not exists report_versions_study_idx on public.report_versions(study_id, version desc);
create index if not exists report_nodes_version_position_idx on public.report_nodes(report_version_id, position);

alter table public.evidence_sources enable row level security;
alter table public.evidence_items enable row level security;
alter table public.claims enable row level security;
alter table public.claim_evidence enable row level security;
alter table public.report_versions enable row level security;
alter table public.report_nodes enable row level security;

create policy evidence_sources_select_member on public.evidence_sources for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy evidence_items_select_member on public.evidence_items for select to authenticated
using (exists (select 1 from public.evidence_sources source where source.id = source_id and public.is_workspace_member(source.workspace_id)));
create policy claims_select_member on public.claims for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy claim_evidence_select_member on public.claim_evidence for select to authenticated
using (exists (select 1 from public.claims claim where claim.id = claim_id and public.is_workspace_member(claim.workspace_id)));
create policy report_versions_select_member on public.report_versions for select to authenticated
using (exists (select 1 from public.studies study where study.id = study_id and public.is_workspace_member(study.workspace_id)));
create policy report_nodes_select_member on public.report_nodes for select to authenticated
using (exists (
  select 1 from public.report_versions version join public.studies study on study.id = version.study_id
  where version.id = report_version_id and public.is_workspace_member(study.workspace_id)
));

grant select on public.evidence_sources, public.evidence_items, public.claims,
  public.claim_evidence, public.report_versions, public.report_nodes to authenticated;
