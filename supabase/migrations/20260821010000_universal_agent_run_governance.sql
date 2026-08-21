-- Per-run governance for Universal Agent reasoning and tool execution.

alter table public.agent_runs
  add column if not exists max_tool_calls integer not null default 6,
  add column if not exists tool_calls_used integer not null default 0,
  add column if not exists max_product_tool_calls integer not null default 4,
  add column if not exists product_tool_calls_used integer not null default 0,
  add column if not exists max_external_tool_calls integer not null default 2,
  add column if not exists external_tool_calls_used integer not null default 0,
  add column if not exists token_budget bigint not null default 100000,
  add column if not exists input_tokens_used bigint not null default 0,
  add column if not exists output_tokens_used bigint not null default 0,
  add column if not exists max_cost_micros bigint not null default 1000000,
  add column if not exists cost_micros_used bigint not null default 0;

alter table public.agent_runs
  drop constraint if exists agent_runs_status_check,
  add constraint agent_runs_status_check check (status in ('queued', 'running', 'completed', 'failed', 'blocked', 'cancelled')),
  add constraint agent_runs_tool_call_limits_check check (
    max_tool_calls between 0 and 24 and tool_calls_used between 0 and max_tool_calls
    and max_product_tool_calls between 0 and 24 and product_tool_calls_used between 0 and max_product_tool_calls
    and max_external_tool_calls between 0 and 24 and external_tool_calls_used between 0 and max_external_tool_calls
  ),
  add constraint agent_runs_budget_limits_check check (
    token_budget between 1 and 1000000
    and input_tokens_used >= 0 and output_tokens_used >= 0
    and max_cost_micros between 1 and 1000000000
    and cost_micros_used >= 0
  );
