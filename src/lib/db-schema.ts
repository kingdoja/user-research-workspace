export const SCHEMA_SQL = `
create table if not exists users (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  auth_user_id uuid unique,
  email text not null unique,
  display_name text not null,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_lowercase check (email = lower(email)),
  constraint users_display_name_not_blank check (length(trim(display_name)) > 0)
);

create table if not exists workspaces (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  name text not null,
  token_balance bigint not null default 1000000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_not_blank check (length(trim(name)) > 0),
  constraint workspaces_token_balance_nonnegative check (token_balance >= 0)
);

create table if not exists workspace_members (
  workspace_id bigint not null references workspaces(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint workspace_members_role_check check (role in ('owner', 'admin', 'member', 'viewer'))
);

create index if not exists workspace_members_user_id_idx on workspace_members(user_id);

create table if not exists sessions (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

create table if not exists studies (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references workspaces(id) on delete cascade,
  created_by bigint not null references users(id) on delete restrict,
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

create index if not exists studies_workspace_id_idx on studies(workspace_id);
create index if not exists studies_created_by_idx on studies(created_by);
create index if not exists studies_workspace_updated_idx on studies(workspace_id, updated_at desc);
create index if not exists studies_workspace_status_idx on studies(workspace_id, status);

create table if not exists study_plans (
  id bigint generated always as identity primary key,
  study_id bigint not null unique references studies(id) on delete cascade,
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

create index if not exists study_plans_study_id_idx on study_plans(study_id);

alter table study_plans add column if not exists source text not null default 'local_rules';
alter table study_plans add column if not exists provider_response_id text;
alter table study_plans add column if not exists provider_model text;
alter table study_plans add column if not exists rationale text not null default '';

create table if not exists study_messages (
  id bigint generated always as identity primary key,
  study_id bigint not null references studies(id) on delete cascade,
  role text not null,
  part_type text not null default 'text',
  content text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint study_messages_role_check check (role in ('user', 'assistant', 'system'))
);

create index if not exists study_messages_study_id_idx on study_messages(study_id);
create index if not exists study_messages_study_created_idx on study_messages(study_id, created_at);

create table if not exists study_runs (
  id bigint generated always as identity primary key,
  study_id bigint not null references studies(id) on delete cascade,
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

create index if not exists study_runs_study_id_idx on study_runs(study_id);
create index if not exists study_runs_status_idx on study_runs(status);

alter table study_runs add column if not exists provider_response_id text;
alter table study_runs add column if not exists provider_model text;
alter table study_runs add column if not exists prompt_version text;
alter table study_runs add column if not exists usage jsonb not null default '{}'::jsonb;

create table if not exists study_events (
  id bigint generated always as identity primary key,
  study_id bigint not null references studies(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists study_events_study_id_idx on study_events(study_id);
create index if not exists study_events_study_created_idx on study_events(study_id, created_at);

create table if not exists reports (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  study_id bigint not null unique references studies(id) on delete cascade,
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

create index if not exists reports_study_id_idx on reports(study_id);

alter table reports add column if not exists content_json jsonb not null default '{}'::jsonb;
`;
