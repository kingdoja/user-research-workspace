-- Bind public web evidence returned by a Universal Agent tool to the exact
-- audited agent step that consumed it.
create table if not exists public.agent_step_source_refs (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  agent_run_id bigint not null references public.agent_runs(id) on delete cascade,
  agent_step_id bigint not null references public.agent_steps(id) on delete cascade,
  candidate_id bigint references public.source_candidates(id) on delete set null,
  snapshot_id bigint references public.source_snapshots(id) on delete set null,
  observation_id bigint references public.source_observations(id) on delete set null,
  source_public_id text not null,
  source_url text not null,
  title text not null,
  excerpt text not null default '',
  content_hash text,
  collected_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (agent_step_id, source_public_id),
  constraint agent_step_source_refs_json_check check (jsonb_typeof(metadata) = 'object'),
  constraint agent_step_source_refs_url_check check (length(trim(source_url)) > 0),
  constraint agent_step_source_refs_title_check check (length(trim(title)) > 0)
);

create index if not exists agent_step_source_refs_run_idx
  on public.agent_step_source_refs(agent_run_id, agent_step_id, id);
create index if not exists agent_step_source_refs_source_idx
  on public.agent_step_source_refs(source_public_id);

alter table public.agent_step_source_refs enable row level security;
drop policy if exists agent_step_source_refs_select_member on public.agent_step_source_refs;
create policy agent_step_source_refs_select_member on public.agent_step_source_refs
  for select to authenticated using (public.is_workspace_member(workspace_id));
grant select on public.agent_step_source_refs to authenticated;
