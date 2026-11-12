begin;

-- 想登录工作台但不是老师、也还不是教务的人：记下来，管理员在「录课管理 → 教务」里能直接选
create table if not exists public.wb_people (
  "openId" text primary key,
  name text not null,
  "triedAt" bigint not null
);
alter table public.wb_people enable row level security;
revoke all on public.wb_people from anon, authenticated;

commit;
