begin;

-- 「课程类型」页里教务对单个课程类型的手动设定：算不算课程。
-- 没设定的按 src/domain/lesson-kind.ts 的规则自动判断（授课类型 1v1/刷题班/1v2班课/班课 才是课程，
-- 咨询、考试、会议、自习、作业、助教等关键词一律不是）。问卷名单和老师评分共用这份设定。
create table if not exists public.feedback_course_type_rules (
  course_type text primary key,
  is_course boolean not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.feedback_course_type_rules enable row level security;
revoke all on public.feedback_course_type_rules from anon;
grant select, insert, update, delete on public.feedback_course_type_rules to authenticated;
drop policy if exists feedback_course_type_rules_admin_all on public.feedback_course_type_rules;
create policy feedback_course_type_rules_admin_all
  on public.feedback_course_type_rules for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

commit;
