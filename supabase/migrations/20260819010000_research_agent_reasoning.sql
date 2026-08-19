-- Link governed Agent Controller mutations to the canonical reasoning ledger.
alter table public.reasoning_decisions
  drop constraint if exists reasoning_decisions_trigger_check,
  add constraint reasoning_decisions_trigger_check check (
    trigger_type in ('checkpoint', 'resume', 'terminal', 'context_refresh', 'agent_controller')
  );

alter table public.reasoning_decision_candidates
  drop constraint if exists reasoning_candidates_action_check,
  add constraint reasoning_candidates_action_check check (
    action_type in (
      'continue', 'append_task', 'stop_expansion', 'finish_run', 'refresh_context',
      'call_tool', 'replan', 'ask_user', 'finish'
    )
  );
