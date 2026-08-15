-- Immutable plan snapshots and stable identifiers for cross-run replay.
alter table public.study_plans
  add column if not exists prompt_version text;

update public.study_plans plan
set prompt_version = coalesce(
  (
    select event.payload ->> 'promptVersion'
    from public.study_events event
    where event.study_id = plan.study_id
      and event.event_type = 'plan.created'
      and nullif(event.payload ->> 'promptVersion', '') is not null
    order by event.created_at desc, event.id desc
    limit 1
  ),
  case when plan.source = 'local_rules' then 'legacy-local-plan-v1' else 'legacy-provider-plan-v1' end
)
where prompt_version is null;

alter table public.study_plans
  alter column prompt_version set default 'local-plan-v1',
  alter column prompt_version set not null;

create table if not exists public.study_plan_versions (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  study_id bigint not null references public.studies(id) on delete cascade,
  version integer not null,
  schema_version text not null default 'research-plan-v1',
  lifecycle_status text not null,
  snapshot_reason text not null,
  brief_snapshot text not null,
  study_type text not null,
  framework text not null,
  methods jsonb not null default '[]'::jsonb,
  persona_filters jsonb not null default '{}'::jsonb,
  persona_count integer not null,
  estimated_duration_minutes integer not null,
  estimated_tokens bigint not null,
  source text not null,
  provider_response_id text,
  provider_model text,
  prompt_version text not null,
  rationale text not null default '',
  content_hash text not null,
  confirmed_by bigint references public.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (study_id, version),
  unique (id, study_id),
  constraint study_plan_versions_version_check check (version > 0),
  constraint study_plan_versions_schema_check check (schema_version = 'research-plan-v1'),
  constraint study_plan_versions_lifecycle_check check (lifecycle_status in ('draft', 'confirmed', 'rejected')),
  constraint study_plan_versions_reason_check check (snapshot_reason in ('confirmation', 'legacy_backfill')),
  constraint study_plan_versions_study_type_check check (study_type in ('user_research', 'fast_insight', 'product_rnd', 'panel_only')),
  constraint study_plan_versions_methods_check check (jsonb_typeof(methods) = 'array'),
  constraint study_plan_versions_filters_check check (jsonb_typeof(persona_filters) = 'object'),
  constraint study_plan_versions_persona_count_check check (persona_count between 1 and 100),
  constraint study_plan_versions_duration_check check (estimated_duration_minutes > 0),
  constraint study_plan_versions_tokens_check check (estimated_tokens >= 0),
  constraint study_plan_versions_hash_check check (content_hash ~ '^[0-9a-f]{64}$')
);

insert into public.study_plan_versions (
  public_id, workspace_id, study_id, version, lifecycle_status, snapshot_reason,
  brief_snapshot, study_type, framework, methods, persona_filters, persona_count,
  estimated_duration_minutes, estimated_tokens, source, provider_response_id,
  provider_model, prompt_version, rationale, content_hash, confirmed_at, created_at
)
select
  'plv_' || replace(gen_random_uuid()::text, '-', ''),
  study.workspace_id,
  study.id,
  plan.version,
  plan.status,
  'legacy_backfill',
  study.brief,
  study.study_type,
  plan.framework,
  plan.methods,
  plan.persona_filters,
  plan.persona_count,
  plan.estimated_duration_minutes,
  plan.estimated_tokens,
  plan.source,
  plan.provider_response_id,
  plan.provider_model,
  plan.prompt_version,
  plan.rationale,
  encode(digest(jsonb_build_object(
    'schemaVersion', 'research-plan-v1',
    'brief', study.brief,
    'studyType', study.study_type,
    'framework', plan.framework,
    'methods', plan.methods,
    'personaFilters', plan.persona_filters,
    'personaCount', plan.persona_count,
    'estimatedDurationMinutes', plan.estimated_duration_minutes,
    'estimatedTokens', plan.estimated_tokens,
    'source', plan.source,
    'providerResponseId', plan.provider_response_id,
    'providerModel', plan.provider_model,
    'promptVersion', plan.prompt_version,
    'rationale', plan.rationale
  )::text, 'sha256'), 'hex'),
  plan.confirmed_at,
  coalesce(plan.confirmed_at, plan.updated_at, plan.created_at)
from public.study_plans plan
join public.studies study on study.id = plan.study_id
where plan.status = 'confirmed'
   or exists (select 1 from public.study_runs run where run.study_id = study.id)
on conflict (study_id, version) do nothing;

alter table public.study_plans
  add column if not exists current_plan_version_id bigint;

update public.study_plans plan
set current_plan_version_id = version.id
from public.study_plan_versions version
where version.study_id = plan.study_id
  and version.version = plan.version
  and plan.current_plan_version_id is null;

alter table public.study_plans
  drop constraint if exists study_plans_current_plan_version_fkey,
  add constraint study_plans_current_plan_version_fkey
    foreign key (current_plan_version_id, study_id)
    references public.study_plan_versions(id, study_id) on delete restrict;

alter table public.study_runs
  add column if not exists public_id text,
  add column if not exists plan_version_id bigint;

update public.study_runs
set public_id = 'run_' || replace(gen_random_uuid()::text, '-', '')
where public_id is null;

alter table public.study_runs
  alter column public_id set default ('run_' || replace(gen_random_uuid()::text, '-', '')),
  alter column public_id set not null;

create unique index if not exists study_runs_public_id_idx
  on public.study_runs(public_id);

update public.study_runs run
set plan_version_id = plan.current_plan_version_id
from public.study_plans plan
where plan.study_id = run.study_id
  and run.plan_version_id is null;

do $$
begin
  if exists (select 1 from public.study_runs where plan_version_id is null) then
    raise exception 'cannot lock every study run to a plan version';
  end if;
end;
$$;

alter table public.study_runs
  alter column plan_version_id set not null,
  drop constraint if exists study_runs_plan_version_fkey,
  add constraint study_runs_plan_version_fkey
    foreign key (plan_version_id, study_id)
    references public.study_plan_versions(id, study_id) on delete restrict;

create index if not exists study_plan_versions_study_created_idx
  on public.study_plan_versions(study_id, version desc, created_at desc);
create index if not exists study_plan_versions_workspace_created_idx
  on public.study_plan_versions(workspace_id, created_at desc);
create index if not exists study_plan_versions_confirmed_idx
  on public.study_plan_versions(study_id, version desc)
  where lifecycle_status = 'confirmed';
create index if not exists study_plan_versions_confirmed_by_idx
  on public.study_plan_versions(confirmed_by)
  where confirmed_by is not null;
create index if not exists study_runs_plan_version_idx
  on public.study_runs(plan_version_id, created_at desc);

create or replace function public.prevent_study_plan_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'study plan versions are immutable';
  end if;
  if exists (select 1 from public.studies study where study.id = old.study_id) then
    raise exception 'study plan versions are immutable';
  end if;
  return old;
end;
$$;

drop trigger if exists study_plan_versions_immutable on public.study_plan_versions;
create trigger study_plan_versions_immutable
before update or delete on public.study_plan_versions
for each row execute function public.prevent_study_plan_version_mutation();

alter table public.study_plan_versions enable row level security;

drop policy if exists study_plan_versions_select_member on public.study_plan_versions;
create policy study_plan_versions_select_member on public.study_plan_versions for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on public.study_plan_versions to authenticated;
