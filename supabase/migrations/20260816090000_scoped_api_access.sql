-- Workspace-scoped API credentials. Secret material is hashed before storage and
-- every authenticated external request is recorded without persisting payloads.

create table if not exists public.workspace_api_keys (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  created_by bigint not null references public.users(id) on delete restrict,
  name text not null,
  secret_prefix text not null,
  secret_hash text not null unique,
  scopes text[] not null,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint workspace_api_keys_name_check check (length(trim(name)) between 2 and 80),
  constraint workspace_api_keys_prefix_check check (length(secret_prefix) between 8 and 24),
  constraint workspace_api_keys_hash_check check (secret_hash ~ '^[a-f0-9]{64}$'),
  constraint workspace_api_keys_scopes_check check (
    cardinality(scopes) between 1 and 6
    and scopes <@ array[
      'context:read', 'personas:read', 'studies:read',
      'studies:write', 'runs:read', 'runs:write'
    ]::text[]
  ),
  constraint workspace_api_keys_expiry_check check (expires_at is null or expires_at > created_at),
  constraint workspace_api_keys_revocation_check check (
    (revoked_at is null and revoked_by is null) or revoked_at is not null
  )
);

create table if not exists public.external_api_audit_events (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  api_key_id bigint not null references public.workspace_api_keys(id) on delete cascade,
  actor_user_id bigint references public.users(id) on delete set null,
  request_id text not null,
  method text not null,
  request_path text not null,
  required_scope text not null,
  outcome text not null,
  response_status integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint external_api_audit_events_method_check check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  constraint external_api_audit_events_path_check check (request_path like '/api/v1/%' or request_path = '/api/mcp'),
  constraint external_api_audit_events_scope_check check (required_scope in (
    'context:read', 'personas:read', 'studies:read',
    'studies:write', 'runs:read', 'runs:write'
  )),
  constraint external_api_audit_events_outcome_check check (outcome in (
    'authorized', 'scope_denied', 'expired', 'revoked', 'membership_revoked'
  )),
  constraint external_api_audit_events_status_check check (
    response_status is null or response_status between 100 and 599
  )
);

create index if not exists workspace_api_keys_workspace_created_idx
  on public.workspace_api_keys(workspace_id, created_at desc, id desc);
create index if not exists workspace_api_keys_active_idx
  on public.workspace_api_keys(workspace_id, revoked_at, expires_at);
create index if not exists external_api_audit_events_workspace_created_idx
  on public.external_api_audit_events(workspace_id, created_at desc, id desc);
create index if not exists external_api_audit_events_key_created_idx
  on public.external_api_audit_events(api_key_id, created_at desc, id desc);

create or replace function public.protect_workspace_api_key_identity()
returns trigger language plpgsql as $$
begin
  if new.workspace_id <> old.workspace_id
     or new.created_by <> old.created_by
     or new.secret_prefix <> old.secret_prefix
     or new.secret_hash <> old.secret_hash
     or new.scopes <> old.scopes
     or new.created_at <> old.created_at then
    raise exception 'API_KEY_IDENTITY_IMMUTABLE';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'API_KEY_REVOCATION_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_api_keys_protect_identity on public.workspace_api_keys;
create trigger workspace_api_keys_protect_identity
before update on public.workspace_api_keys
for each row execute function public.protect_workspace_api_key_identity();

alter table public.workspace_api_keys enable row level security;
alter table public.external_api_audit_events enable row level security;

-- These tables intentionally have no authenticated-role grants or RLS policies.
-- The server DAL returns redacted DTOs and never exposes secret_hash.
