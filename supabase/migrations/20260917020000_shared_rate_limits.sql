create table if not exists public.request_rate_limits (
  key_hash text primary key,
  request_count integer not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint request_rate_limits_count_check check (request_count > 0)
);

create index if not exists request_rate_limits_expiry_idx
  on public.request_rate_limits(expires_at);

revoke all on public.request_rate_limits from public, authenticated;
