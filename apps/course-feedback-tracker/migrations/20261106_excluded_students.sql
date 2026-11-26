begin;

-- 不参与反馈统计的学生（例：公司内部试听、不计分的旁听）。按学生名记一次，所有月份生效。
-- 任务照常生成、答卷照常对账，只在工作台的统计、表格和「对不上」横幅里隐藏；移出名单即恢复。
create table if not exists public.feedback_excluded_students (
  student_name text primary key,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.feedback_excluded_students enable row level security;
revoke all on public.feedback_excluded_students from anon;
grant select, insert, update, delete on public.feedback_excluded_students to authenticated;
drop policy if exists feedback_excluded_students_admin_all on public.feedback_excluded_students;
create policy feedback_excluded_students_admin_all
  on public.feedback_excluded_students for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

commit;
