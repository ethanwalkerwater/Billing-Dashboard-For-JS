begin;

-- 登录只认飞书，管理员只认这三个人的飞书姓名。
-- 与 src/domain/admin-allowlist.ts 的 FEEDBACK_ADMIN_NAMES 保持一致。
-- feedback_admins 里按 user_id 登记的旧账号（包括共享密码账号）不再获得权限。

create table if not exists public.feedback_admin_allowlist (
  display_name text primary key,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.feedback_admin_allowlist (display_name)
values ('包天翊'), ('黄钢'), ('徐翰超')
on conflict (display_name) do update set active = excluded.active;

alter table public.feedback_admin_allowlist enable row level security;
revoke all on public.feedback_admin_allowlist from public, anon, authenticated;

create or replace function public.feedback_name_key(raw text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    lower(normalize(btrim(coalesce(raw, '')), NFKC)),
    '[[:space:]]+',
    '',
    'g'
  );
$$;

create or replace function public.feedback_provider_is_feishu(meta jsonb)
returns boolean
language sql
immutable
as $$
  select
    lower(coalesce(meta ->> 'provider', '')) in ('feishu', 'lark')
    or exists (
      select 1
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(meta -> 'providers') = 'array' then meta -> 'providers'
          else '[]'::jsonb
        end
      ) as provider(value)
      where lower(provider.value) in ('feishu', 'lark')
    );
$$;

create or replace function public.is_feedback_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.feedback_provider_is_feishu(auth.jwt() -> 'app_metadata')
    and public.feedback_name_key(coalesce(
      auth.jwt() ->> 'name',
      auth.jwt() -> 'user_metadata' ->> 'name',
      auth.jwt() -> 'user_metadata' ->> 'nickname'
    )) <> ''
    and public.feedback_name_key(coalesce(
      auth.jwt() ->> 'name',
      auth.jwt() -> 'user_metadata' ->> 'name',
      auth.jwt() -> 'user_metadata' ->> 'nickname'
    )) in (
      select public.feedback_name_key(display_name)
      from public.feedback_admin_allowlist
      where active
    );
$$;

-- 云函数只有 uid，没有浏览器 JWT。用 auth.users 上的同一条姓名 + 飞书规则判断。
create or replace function public.feedback_uid_is_admin(target_uid text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users as account
    where account.id = target_uid
      and public.feedback_provider_is_feishu(account.app_metadata)
      and public.feedback_name_key(coalesce(
        account.user_metadata ->> 'name',
        account.user_metadata ->> 'nickname',
        to_jsonb(account) ->> 'name'
      )) <> ''
      and public.feedback_name_key(coalesce(
        account.user_metadata ->> 'name',
        account.user_metadata ->> 'nickname',
        to_jsonb(account) ->> 'name'
      )) in (
        select public.feedback_name_key(display_name)
        from public.feedback_admin_allowlist
        where active
      )
  );
$$;

revoke all on function public.feedback_uid_is_admin(text) from public, anon, authenticated;
grant execute on function public.feedback_uid_is_admin(text) to service_role;

commit;
