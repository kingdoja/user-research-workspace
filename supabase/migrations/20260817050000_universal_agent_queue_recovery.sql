-- Move Universal Agent execution behind the durable worker queue. A queued or
-- leased run is unique per thread so browser retries cannot duplicate effects.

alter table public.agent_runs
  add column if not exists idempotency_key text,
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists attempt_count integer not null default 0,
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz;

-- Runs created by the synchronous implementation cannot be resumed safely
-- because an external tool may already have produced an unrecorded side effect.
update public.agent_steps
set status = 'failed',
    error_code = coalesce(error_code, 'AGENT_RUNTIME_UPGRADE_INTERRUPTED'),
    error_message = coalesce(error_message, 'Agent execution was interrupted by the durable queue upgrade'),
    finished_at = coalesce(finished_at, now())
where status = 'running'
  and run_id in (select id from public.agent_runs where status = 'running');

update public.sandbox_executions
set status = 'cancelled',
    error_code = coalesce(error_code, 'AGENT_RUNTIME_UPGRADE_INTERRUPTED'),
    error_message = coalesce(error_message, 'Agent execution was interrupted by the durable queue upgrade'),
    finished_at = coalesce(finished_at, now())
where status = 'running'
  and agent_run_id in (select id from public.agent_runs where status = 'running');

update public.provider_route_decisions
set status = 'failed',
    error_code = coalesce(error_code, 'AGENT_RUNTIME_UPGRADE_INTERRUPTED'),
    latency_ms = least(2147483647, greatest(0, extract(epoch from (now() - created_at)) * 1000))::integer,
    finished_at = coalesce(finished_at, now())
where status = 'selected'
  and agent_run_id in (select id from public.agent_runs where status = 'running');

update public.agent_runs
set status = 'failed',
    error_code = coalesce(error_code, 'AGENT_RUNTIME_UPGRADE_INTERRUPTED'),
    error_message = coalesce(error_message, 'Agent execution was interrupted before the durable worker queue was enabled'),
    finished_at = coalesce(finished_at, now()),
    lease_owner = null,
    lease_expires_at = null,
    heartbeat_at = null
where status = 'running';

update public.agent_runs
set idempotency_key = 'legacy:' || public_id
where idempotency_key is null;

alter table public.agent_runs
  alter column idempotency_key set not null,
  drop constraint if exists agent_runs_status_check,
  add constraint agent_runs_status_check check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  add constraint agent_runs_idempotency_key_check check (length(idempotency_key) between 8 and 160),
  add constraint agent_runs_attempt_count_check check (attempt_count between 0 and 100),
  add constraint agent_runs_lease_check check (
    (status = 'running' and lease_owner is not null and lease_expires_at is not null and heartbeat_at is not null)
    or (status <> 'running' and lease_owner is null and lease_expires_at is null and heartbeat_at is null)
  );

create unique index if not exists agent_runs_thread_idempotency_idx
  on public.agent_runs(thread_id, idempotency_key);

create unique index if not exists agent_runs_one_active_thread_idx
  on public.agent_runs(thread_id) where status in ('queued', 'running');

create index if not exists agent_runs_queue_claim_idx
  on public.agent_runs(available_at, started_at, id) where status = 'queued';

create index if not exists agent_runs_expired_lease_idx
  on public.agent_runs(lease_expires_at, id) where status = 'running';

alter table public.skill_executions
  add column if not exists agent_run_id bigint references public.agent_runs(id) on delete set null,
  add column if not exists agent_step_id bigint references public.agent_steps(id) on delete set null;

create index if not exists skill_executions_agent_run_idx
  on public.skill_executions(agent_run_id, started_at, id) where agent_run_id is not null;
