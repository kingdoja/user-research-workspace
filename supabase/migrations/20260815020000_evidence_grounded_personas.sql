-- Evidence-grounded Persona links, reuse retention gate, and governance audit.
alter table public.study_personas
  add column if not exists evidence_status text not null default 'ungrounded',
  add column if not exists evidence_confidence text not null default 'low',
  add column if not exists grounding_summary jsonb not null default '{}'::jsonb,
  add column if not exists grounded_at timestamptz,
  add column if not exists retention_status text not null default 'retained',
  add column if not exists valid_until timestamptz,
  add column if not exists retention_reviewed_by bigint references public.users(id) on delete set null,
  add column if not exists retention_reviewed_at timestamptz,
  add column if not exists retention_note text;

alter table public.study_personas
  drop constraint if exists study_personas_evidence_status_check,
  add constraint study_personas_evidence_status_check check (
    evidence_status in ('ungrounded', 'synthetic_grounded', 'human_grounded', 'mixed_grounded', 'context_grounded', 'unsupported')
  ),
  drop constraint if exists study_personas_evidence_confidence_check,
  add constraint study_personas_evidence_confidence_check check (evidence_confidence in ('low', 'medium', 'high')),
  drop constraint if exists study_personas_retention_status_check,
  add constraint study_personas_retention_status_check check (retention_status in ('pending', 'retained', 'retired')),
  drop constraint if exists study_personas_grounding_summary_check,
  add constraint study_personas_grounding_summary_check check (jsonb_typeof(grounding_summary) = 'object');

create index if not exists study_personas_reuse_gate_idx
  on public.study_personas(workspace_id, retention_status, valid_until, updated_at desc);
create index if not exists study_personas_evidence_status_idx
  on public.study_personas(workspace_id, evidence_status, evidence_confidence);

create table if not exists public.persona_evidence_links (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  persona_id bigint not null references public.study_personas(id) on delete cascade,
  evidence_item_id bigint not null references public.evidence_items(id) on delete cascade,
  relation text not null default 'context',
  profile_path text not null default '$',
  rationale text not null default '',
  link_source text not null default 'automatic',
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (persona_id, evidence_item_id, profile_path),
  constraint persona_evidence_links_relation_check check (relation in ('supports', 'contradicts', 'context')),
  constraint persona_evidence_links_source_check check (link_source in ('automatic', 'manual')),
  constraint persona_evidence_links_profile_path_check check (length(trim(profile_path)) > 0)
);

create index if not exists persona_evidence_links_persona_idx
  on public.persona_evidence_links(persona_id, created_at desc);
create index if not exists persona_evidence_links_evidence_idx
  on public.persona_evidence_links(evidence_item_id, persona_id);

create table if not exists public.persona_governance_events (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  persona_id bigint not null references public.study_personas(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists persona_governance_events_persona_idx
  on public.persona_governance_events(persona_id, created_at desc);
create index if not exists persona_governance_events_workspace_idx
  on public.persona_governance_events(workspace_id, created_at desc);

alter table public.persona_evidence_links enable row level security;
alter table public.persona_governance_events enable row level security;

drop policy if exists persona_evidence_links_select_member on public.persona_evidence_links;
create policy persona_evidence_links_select_member on public.persona_evidence_links for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists persona_governance_events_select_member on public.persona_governance_events;
create policy persona_governance_events_select_member on public.persona_governance_events for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.persona_evidence_links, public.persona_governance_events to authenticated;
