-- Expand Universal Agent research budgets while retaining the existing hard
-- constraints and token/cost safeguards.
alter table public.agent_runs
  alter column max_steps set default 12,
  alter column max_tool_calls set default 12,
  alter column max_product_tool_calls set default 12,
  alter column max_external_tool_calls set default 4;
