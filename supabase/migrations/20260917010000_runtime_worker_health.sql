create table if not exists public.runtime_worker_heartbeats (
  worker_id text primary key,
  worker_kind text not null,
  status text not null default 'running',
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  constraint runtime_worker_heartbeats_status_check check (status in ('running', 'stopping'))
);

create index if not exists runtime_worker_heartbeats_recent_idx
  on public.runtime_worker_heartbeats(heartbeat_at desc);

revoke all on public.runtime_worker_heartbeats from public, authenticated;
