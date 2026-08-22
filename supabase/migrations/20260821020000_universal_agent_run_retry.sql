-- A retry is a new immutable run linked to its failed or blocked source run.

alter table public.agent_runs
  add column if not exists retry_of_run_id bigint references public.agent_runs(id) on delete set null;

create index if not exists agent_runs_retry_source_idx
  on public.agent_runs(retry_of_run_id, started_at desc, id desc)
  where retry_of_run_id is not null;
