-- Durable real-time interview agents, replay metadata, and human quality reviews.
alter table public.interview_sessions
  add column if not exists workflow_type text not null default 'static_form',
  add column if not exists workflow_version text not null default 'static-form-v1',
  add column if not exists skill_slug text,
  add column if not exists skill_version integer,
  add column if not exists strategy_key text not null default 'default',
  add column if not exists strategy_version text not null default 'v1',
  add column if not exists experiment_assignment_id bigint,
  add column if not exists invitation_id bigint references public.interview_invitations(id) on delete set null,
  add column if not exists resume_token_hash text,
  add column if not exists current_question_position integer,
  add column if not exists followup_count integer not null default 0,
  add column if not exists context_retrieval_id bigint,
  add column if not exists started_at timestamptz,
  add column if not exists last_activity_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists error_message text,
  add column if not exists timeout_seconds integer not null default 1800,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.interview_sessions
  drop constraint if exists interview_sessions_status_check,
  add constraint interview_sessions_status_check check (
    status in ('waiting_participant', 'responding', 'completed', 'cancelled', 'failed', 'running')
  ),
  drop constraint if exists interview_sessions_workflow_type_check,
  add constraint interview_sessions_workflow_type_check check (workflow_type in ('static_form', 'realtime_agent', 'synthetic_batch')),
  drop constraint if exists interview_sessions_timeout_seconds_check,
  add constraint interview_sessions_timeout_seconds_check check (timeout_seconds between 60 and 7200),
  drop constraint if exists interview_sessions_followup_count_check,
  add constraint interview_sessions_followup_count_check check (followup_count >= 0),
  drop constraint if exists interview_sessions_experiment_assignment_id_fkey,
  add constraint interview_sessions_experiment_assignment_id_fkey
    foreign key (experiment_assignment_id) references public.strategy_assignments(id) on delete set null,
  drop constraint if exists interview_sessions_context_retrieval_id_fkey,
  add constraint interview_sessions_context_retrieval_id_fkey
    foreign key (context_retrieval_id) references public.context_retrievals(id) on delete set null;

alter table public.interview_messages
  add column if not exists public_id text,
  add column if not exists question_id bigint references public.interview_questions(id) on delete set null,
  add column if not exists message_type text not null default 'question',
  add column if not exists idempotency_key text,
  add column if not exists provider_response_id text,
  add column if not exists provider_model text,
  add column if not exists prompt_version text,
  add column if not exists skill_slug text,
  add column if not exists skill_version integer,
  add column if not exists strategy_version text,
  add column if not exists context_retrieval_id bigint,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.interview_messages
set public_id = 'inm_' || replace(gen_random_uuid()::text, '-', '')
where public_id is null;

alter table public.interview_messages alter column public_id set not null;
alter table public.interview_messages alter column public_id set default ('inm_' || replace(gen_random_uuid()::text, '-', ''));

update public.interview_messages
set message_type = case when role = 'persona' then 'answer' else 'question' end;

update public.interview_sessions
set workflow_type = case when session_type = 'ai' then 'synthetic_batch' else 'static_form' end,
    workflow_version = case when session_type = 'ai' then 'synthetic-interview-v1' else 'static-form-v1' end,
    skill_slug = case when session_type = 'ai' then 'generate-synthetic-interviews' else null end,
    skill_version = case when session_type = 'ai' then 1 else null end;

alter table public.interview_messages
  drop constraint if exists interview_messages_role_check,
  add constraint interview_messages_role_check check (role in ('interviewer', 'persona', 'participant', 'agent', 'system')),
  drop constraint if exists interview_messages_type_check,
  add constraint interview_messages_type_check check (message_type in ('question', 'answer', 'followup', 'closing', 'system', 'error')),
  drop constraint if exists interview_messages_context_retrieval_id_fkey,
  add constraint interview_messages_context_retrieval_id_fkey
    foreign key (context_retrieval_id) references public.context_retrievals(id) on delete set null;

create unique index if not exists interview_messages_public_id_idx on public.interview_messages(public_id);
create unique index if not exists interview_messages_idempotency_idx
  on public.interview_messages(session_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists interview_sessions_resume_token_idx
  on public.interview_sessions(resume_token_hash) where resume_token_hash is not null;
create index if not exists interview_sessions_workflow_status_idx
  on public.interview_sessions(project_id, workflow_type, status, created_at desc);
create index if not exists interview_sessions_assignment_idx on public.interview_sessions(experiment_assignment_id);

alter table public.strategy_assignments
  add column if not exists interview_session_id bigint references public.interview_sessions(id) on delete cascade;

alter table public.strategy_assignments alter column study_id drop not null;
alter table public.strategy_assignments alter column run_id drop not null;

alter table public.strategy_assignments drop constraint if exists strategy_assignments_run_id_key;
create unique index if not exists strategy_assignments_run_unique_idx
  on public.strategy_assignments(run_id) where run_id is not null;
create unique index if not exists strategy_assignments_interview_session_unique_idx
  on public.strategy_assignments(interview_session_id) where interview_session_id is not null;

alter table public.context_retrievals
  add column if not exists interview_session_id bigint references public.interview_sessions(id) on delete cascade;

create unique index if not exists context_retrievals_one_per_interview_session_idx
  on public.context_retrievals(interview_session_id) where interview_session_id is not null;

create table if not exists public.interview_quality_reviews (
  id bigint generated always as identity primary key,
  public_id text not null unique,
  session_id bigint not null references public.interview_sessions(id) on delete cascade,
  reviewer_user_id bigint not null references public.users(id) on delete cascade,
  relevance smallint not null,
  depth smallint not null,
  followup_quality smallint not null,
  consistency smallint not null,
  evidence_grounding smallint not null,
  safety_compliance smallint not null,
  overall_score double precision not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, reviewer_user_id),
  constraint interview_quality_reviews_relevance_check check (relevance between 1 and 5),
  constraint interview_quality_reviews_depth_check check (depth between 1 and 5),
  constraint interview_quality_reviews_followup_check check (followup_quality between 1 and 5),
  constraint interview_quality_reviews_consistency_check check (consistency between 1 and 5),
  constraint interview_quality_reviews_grounding_check check (evidence_grounding between 1 and 5),
  constraint interview_quality_reviews_safety_check check (safety_compliance between 1 and 5),
  constraint interview_quality_reviews_overall_check check (overall_score between 1 and 5)
);

create index if not exists interview_quality_reviews_session_idx on public.interview_quality_reviews(session_id, updated_at desc);
alter table public.interview_quality_reviews enable row level security;

create policy interview_quality_reviews_select_member on public.interview_quality_reviews for select to authenticated
using (exists (
  select 1 from public.interview_sessions session
  join public.interview_projects project on project.id = session.project_id
  where session.id = session_id and public.is_workspace_member(project.workspace_id)
));

grant select on public.interview_quality_reviews to authenticated;
