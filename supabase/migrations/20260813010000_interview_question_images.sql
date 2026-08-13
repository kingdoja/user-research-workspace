alter table public.interview_questions
  add column if not exists image_paths jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'interview_questions_image_paths_check'
      and conrelid = 'public.interview_questions'::regclass
  ) then
    alter table public.interview_questions
      add constraint interview_questions_image_paths_check check (
        jsonb_typeof(image_paths) = 'array' and jsonb_array_length(image_paths) <= 4
      );
  end if;
end
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'interview-question-images',
  'interview-question-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists interview_question_images_insert_member on storage.objects;
create policy interview_question_images_insert_member on storage.objects for insert to authenticated
with check (
  bucket_id = 'interview-question-images'
  and exists (
    select 1
    from public.interview_projects project
    join public.workspace_members member on member.workspace_id = project.workspace_id
    join public.users app_user on app_user.id = member.user_id
    where project.public_id = (storage.foldername(name))[1]
      and app_user.auth_user_id = (select auth.uid())
      and member.role <> 'viewer'
  )
);

drop policy if exists interview_question_images_delete_member on storage.objects;
create policy interview_question_images_delete_member on storage.objects for delete to authenticated
using (
  bucket_id = 'interview-question-images'
  and exists (
    select 1
    from public.interview_projects project
    join public.workspace_members member on member.workspace_id = project.workspace_id
    join public.users app_user on app_user.id = member.user_id
    where project.public_id = (storage.foldername(name))[1]
      and app_user.auth_user_id = (select auth.uid())
      and member.role <> 'viewer'
  )
);

drop policy if exists interview_question_images_select_member on storage.objects;
create policy interview_question_images_select_member on storage.objects for select to authenticated
using (
  bucket_id = 'interview-question-images'
  and exists (
    select 1
    from public.interview_projects project
    join public.workspace_members member on member.workspace_id = project.workspace_id
    join public.users app_user on app_user.id = member.user_id
    where project.public_id = (storage.foldername(name))[1]
      and app_user.auth_user_id = (select auth.uid())
  )
);
