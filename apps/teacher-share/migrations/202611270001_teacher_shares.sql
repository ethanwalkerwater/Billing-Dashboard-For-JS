-- 老师分享页：教务在 /share/ 挑老师、写标题和介绍，官网 jsjy.asia/s/<code> 给家长看。
-- 只有云函数 share-api（service_role）读写：开 RLS、不建 policy，飞书登录的普通账号直连数据库读不到也写不了。可重复执行。
create table if not exists public.teacher_shares (
  code text primary key check (code ~ '^[A-Za-z0-9]{8}$'),
  title text not null check (char_length(title) between 1 and 30),
  intro text not null default '' check (char_length(intro) <= 400),
  teachers text[] not null check (cardinality(teachers) between 1 and 30),
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

alter table public.teacher_shares enable row level security;
revoke all on public.teacher_shares from anon, authenticated;
