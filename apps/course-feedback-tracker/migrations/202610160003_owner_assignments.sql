begin;

-- 负责人改成「从某个月起生效」：只存教务手动设的那一次，之后的月份没设就沿用（src/domain/owners.ts ownerResolver）。
-- 原来存在每个任务上、只在生成名单时复制一次，先生成了 10 月名单再去改 9 月，10 月就跟不上。
-- 不加 check 约束：教务换人只改前端的 TASK_OWNERS，不用为此迁移。
create table if not exists public.feedback_owner_assignments (
  student_record_id text not null,
  teacher_canonical_name text not null,
  from_month text not null check (from_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  owner text not null,
  updated_at timestamptz not null default now(),
  primary key (student_record_id, teacher_canonical_name, from_month)
);

alter table public.feedback_owner_assignments enable row level security;
revoke all on public.feedback_owner_assignments from anon;
grant select, insert, update, delete on public.feedback_owner_assignments to authenticated;
drop policy if exists feedback_owner_assignments_admin_all on public.feedback_owner_assignments;
create policy feedback_owner_assignments_admin_all
  on public.feedback_owner_assignments for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

-- 已经在任务上设过的搬过来，从那个任务的课程月份起生效
insert into public.feedback_owner_assignments (student_record_id, teacher_canonical_name, from_month, owner)
select student_record_id, teacher_canonical_name, course_month, owner
from public.feedback_tasks
where owner is not null
on conflict (student_record_id, teacher_canonical_name, from_month) do update set owner = excluded.owner;

alter table public.feedback_tasks drop column if exists owner;

commit;
