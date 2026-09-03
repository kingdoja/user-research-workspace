-- Incremental, user-safe output for Universal Agent runs.
-- Events are append-only so SSE clients can resume without mutating the
-- canonical agent_messages/agent_steps audit trail.

create table if not exists public.agent_run_stream_events (
  id bigint generated always as identity primary key,
  run_id bigint not null references public.agent_runs(id) on delete cascade,
  thread_id bigint not null references public.agent_threads(id) on delete cascade,
  event_type text not null,
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_run_stream_events_type_check check (
    event_type in ('assistant.start', 'assistant.delta', 'assistant.reset', 'assistant.commit', 'assistant.error')
  ),
  constraint agent_run_stream_events_content_check check (length(content) <= 120000),
  constraint agent_run_stream_events_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists agent_run_stream_events_run_idx
  on public.agent_run_stream_events(run_id, id);
create index if not exists agent_run_stream_events_thread_idx
  on public.agent_run_stream_events(thread_id, id);

alter table public.agent_run_stream_events enable row level security;

drop policy if exists agent_run_stream_events_select_member on public.agent_run_stream_events;
create policy agent_run_stream_events_select_member on public.agent_run_stream_events
  for select to authenticated
  using (
    exists (
      select 1
      from public.agent_runs run
      where run.id = agent_run_stream_events.run_id
        and public.is_workspace_member(run.workspace_id)
    )
  );

grant select on public.agent_run_stream_events to authenticated;
