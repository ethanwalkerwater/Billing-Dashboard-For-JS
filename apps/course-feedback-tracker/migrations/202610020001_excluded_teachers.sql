begin;

-- 不参与反馈统计的老师（例：只带自习、助教、行政兼课）。按老师规范名记一次，所有月份生效。
-- 任务照常生成、答卷照常对账，只在工作台的统计、表格和「对不上」横幅里隐藏；移出名单即恢复。
create table if not exists public.feedback_excluded_teachers (
  teacher_name text primary key,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.feedback_excluded_teachers enable row level security;
revoke all on public.feedback_excluded_teachers from anon;
grant select, insert, update, delete on public.feedback_excluded_teachers to authenticated;
drop policy if exists feedback_excluded_teachers_admin_all on public.feedback_excluded_teachers;
create policy feedback_excluded_teachers_admin_all
  on public.feedback_excluded_teachers for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

commit;
