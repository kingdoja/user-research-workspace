-- Keep direct Plan Version mutation forbidden while allowing parent workspace/study cleanup to cascade.
create or replace function public.prevent_study_plan_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'study plan versions are immutable';
  end if;
  if pg_trigger_depth() = 1
     and exists (select 1 from public.studies study where study.id = old.study_id) then
    raise exception 'study plan versions are immutable';
  end if;
  return old;
end;
$$;
