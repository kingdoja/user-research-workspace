-- Persist the selected GPT Researcher report strategy with both the editable
-- plan and its immutable confirmation snapshot.
alter table public.study_plans
  add column if not exists gpt_researcher_report_type text;

update public.study_plans
set gpt_researcher_report_type = coalesce(nullif(gpt_researcher_report_type, ''), 'research_report');

alter table public.study_plans
  alter column gpt_researcher_report_type set default 'research_report',
  alter column gpt_researcher_report_type set not null;

alter table public.study_plans
  drop constraint if exists study_plans_gpt_researcher_report_type_check,
  add constraint study_plans_gpt_researcher_report_type_check
    check (gpt_researcher_report_type in ('research_report', 'deep', 'detailed_report', 'subtopic_report'));

alter table public.study_plan_versions
  add column if not exists gpt_researcher_report_type text default 'research_report';

alter table public.study_plan_versions
  alter column gpt_researcher_report_type set default 'research_report',
  alter column gpt_researcher_report_type set not null;

alter table public.study_plan_versions
  drop constraint if exists study_plan_versions_gpt_researcher_report_type_check,
  add constraint study_plan_versions_gpt_researcher_report_type_check
    check (gpt_researcher_report_type in ('research_report', 'deep', 'detailed_report', 'subtopic_report'));
