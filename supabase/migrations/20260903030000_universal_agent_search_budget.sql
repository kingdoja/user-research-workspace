-- Give new Universal Agent Runs enough room for search -> open -> synthesis.
-- Existing rows are intentionally untouched so their audit/retry limits remain
-- reproducible; the application supplies these defaults for newly queued Runs.
alter table public.agent_runs
  alter column max_steps set default 8,
  alter column max_product_tool_calls set default 8,
  alter column max_external_tool_calls set default 3;
