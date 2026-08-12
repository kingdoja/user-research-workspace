create extension if not exists pgcrypto;

create table public.users (
  id bigint generated always as identity primary key,
  public_id text not null unique default ('usr_' || replace(gen_random_uuid()::text, '-', '')),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_lowercase check (email = lower(email)),
  constraint users_display_name_not_blank check (length(trim(display_name)) > 0)
);

create table public.workspaces (
  id bigint generated always as identity primary key,
  public_id text not null unique default ('wsp_' || replace(gen_random_uuid()::text, '-', '')),
  name text not null,
  token_balance bigint not null default 1000000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_not_blank check (length(trim(name)) > 0),
  constraint workspaces_token_balance_nonnegative check (token_balance >= 0)
);

create table public.workspace_members (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint workspace_members_role_check check (role in ('owner', 'admin', 'member', 'viewer'))
);

create index workspace_members_user_id_idx on public.workspace_members(user_id);

create table public.studies (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint not null references public.users(id) on delete restrict,
  title text not null,
  brief text not null,
  study_type text not null default 'user_research',
  status text not null default 'planning',
  current_stage text not null default 'clarification',
  estimated_tokens bigint not null default 0,
  consumed_tokens bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studies_title_not_blank check (length(trim(title)) > 0),
  constraint studies_brief_not_blank check (length(trim(brief)) > 0),
  constraint studies_type_check check (study_type in ('user_research', 'fast_insight', 'product_rnd', 'panel_only')),
  constraint studies_status_check check (status in ('planning', 'awaiting_confirmation', 'queued', 'running', 'completed', 'cancelled', 'failed')),
  constraint studies_stage_check check (current_stage in ('brief', 'clarification', 'confirmation', 'execution', 'report')),
  constraint studies_token_usage_nonnegative check (estimated_tokens >= 0 and consumed_tokens >= 0)
);

create index studies_workspace_id_idx on public.studies(workspace_id);
create index studies_created_by_idx on public.studies(created_by);
create index studies_workspace_updated_idx on public.studies(workspace_id, updated_at desc);
create index studies_workspace_status_idx on public.studies(workspace_id, status);

create table public.study_plans (
  id bigint generated always as identity primary key,
  study_id bigint not null unique references public.studies(id) on delete cascade,
  version integer not null default 1,
  framework text not null,
  methods jsonb not null default '[]'::jsonb,
  persona_filters jsonb not null default '{}'::jsonb,
  persona_count integer not null,
  estimated_duration_minutes integer not null,
  estimated_tokens bigint not null,
  source text not null default 'local_rules',
  provider_response_id text,
  provider_model text,
  rationale text not null default '',
  status text not null default 'draft',
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_plans_persona_count_check check (persona_count between 1 and 100),
  constraint study_plans_duration_check check (estimated_duration_minutes > 0),
  constraint study_plans_tokens_check check (estimated_tokens >= 0),
  constraint study_plans_status_check check (status in ('draft', 'confirmed', 'rejected'))
);

create table public.study_messages (
  id bigint generated always as identity primary key,
  study_id bigint not null references public.studies(id) on delete cascade,
  role text not null,
  part_type text not null default 'text',
  content text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint study_messages_role_check check (role in ('user', 'assistant', 'system'))
);

create index study_messages_study_id_idx on public.study_messages(study_id);
create index study_messages_study_created_idx on public.study_messages(study_id, created_at);

create table public.study_runs (
  id bigint generated always as identity primary key,
  study_id bigint not null references public.studies(id) on delete cascade,
  status text not null default 'awaiting_provider',
  provider text,
  provider_response_id text,
  provider_model text,
  prompt_version text,
  usage jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  constraint study_runs_status_check check (status in ('awaiting_provider', 'queued', 'running', 'completed', 'failed', 'cancelled'))
);

create index study_runs_study_id_idx on public.study_runs(study_id);
create index study_runs_status_idx on public.study_runs(status);

create table public.study_events (
  id bigint generated always as identity primary key,
  study_id bigint not null references public.studies(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index study_events_study_id_idx on public.study_events(study_id);
create index study_events_study_created_idx on public.study_events(study_id, created_at);

create table public.reports (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  study_id bigint not null unique references public.studies(id) on delete cascade,
  title text not null,
  description text not null default '',
  content_html text not null,
  content_json jsonb not null default '{}'::jsonb,
  cover_url text,
  share_enabled boolean not null default false,
  share_token text unique,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  new_user_id bigint;
  new_workspace_id bigint;
  profile_name text;
begin
  profile_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1));

  insert into public.users (auth_user_id, email, display_name)
  values (new.id, lower(new.email), profile_name)
  returning id into new_user_id;

  insert into public.workspaces (name)
  values (profile_name || ' 的研究工作区')
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new_user_id, 'owner');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

create or replace function public.is_workspace_member(target_workspace_id bigint)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    join public.users u on u.id = wm.user_id
    where wm.workspace_id = target_workspace_id and u.auth_user_id = auth.uid()
  );
$$;

revoke all on function public.is_workspace_member(bigint) from public;
grant execute on function public.is_workspace_member(bigint) to authenticated;

alter table public.users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.studies enable row level security;
alter table public.study_plans enable row level security;
alter table public.study_messages enable row level security;
alter table public.study_runs enable row level security;
alter table public.study_events enable row level security;
alter table public.reports enable row level security;

create policy users_select_self on public.users for select to authenticated
using (auth_user_id = auth.uid());

create policy workspaces_select_member on public.workspaces for select to authenticated
using (public.is_workspace_member(id));

create policy workspace_members_select_member on public.workspace_members for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy studies_select_member on public.studies for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy study_plans_select_member on public.study_plans for select to authenticated
using (exists (select 1 from public.studies s where s.id = study_id and public.is_workspace_member(s.workspace_id)));

create policy study_messages_select_member on public.study_messages for select to authenticated
using (exists (select 1 from public.studies s where s.id = study_id and public.is_workspace_member(s.workspace_id)));

create policy study_runs_select_member on public.study_runs for select to authenticated
using (exists (select 1 from public.studies s where s.id = study_id and public.is_workspace_member(s.workspace_id)));

create policy study_events_select_member on public.study_events for select to authenticated
using (exists (select 1 from public.studies s where s.id = study_id and public.is_workspace_member(s.workspace_id)));

create policy reports_select_member on public.reports for select to authenticated
using (exists (select 1 from public.studies s where s.id = study_id and public.is_workspace_member(s.workspace_id)));

grant usage on schema public to authenticated;
grant select on public.users, public.workspaces, public.workspace_members, public.studies,
  public.study_plans, public.study_messages, public.study_runs, public.study_events, public.reports
  to authenticated;
