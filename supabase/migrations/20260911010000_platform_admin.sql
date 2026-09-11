alter table public.users
  add column if not exists is_platform_admin boolean not null default false;

create index if not exists users_platform_admin_idx
  on public.users(is_platform_admin)
  where is_platform_admin = true;

comment on column public.users.is_platform_admin is
  'Grants read-only cross-workspace access to the platform admin console.';
