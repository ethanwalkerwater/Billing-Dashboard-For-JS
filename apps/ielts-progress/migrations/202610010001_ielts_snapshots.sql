-- 雅思正向率。整套数据只有两行 JSON 快照：feishu（云函数每次同步整行替换）、legacy（历史 CSV 一次性导入）。
-- 复用反馈追踪系统的 feedback_admins 白名单 + is_feedback_admin()，同一个 jsjy 账号登录；浏览器只读，写入只走 service_role。
begin;

create table if not exists public.ielts_snapshots (
  key text primary key check (key in ('feishu', 'legacy')),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.ielts_snapshots enable row level security;
grant select on public.ielts_snapshots to authenticated;

drop policy if exists ielts_snapshots_admin_read on public.ielts_snapshots;
create policy ielts_snapshots_admin_read on public.ielts_snapshots
  for select to authenticated using ((select public.is_feedback_admin()));

commit;
