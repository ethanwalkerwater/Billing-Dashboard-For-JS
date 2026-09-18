begin;

-- 业务方决定：不往飞书反馈表加任何字段，不依赖任务 ID。
-- 答卷按（学生姓名, 老师姓名）匹配任务；匹配不上的列出来，教务手动绑定。

-- 一行任务直接带着"学生填了没 / 家长填了没"，列表不用 join 答卷表。
alter table public.feedback_tasks
  add column if not exists student_response_id text,
  add column if not exists parent_response_id text,
  add column if not exists bound_by text check (bound_by in ('name', 'manual'));

-- 问卷里的写法 → 课表规范名。例：Valentina 林 → Valentina Lin，马老师 → 马怡婷。
create table if not exists public.feedback_name_aliases (
  kind text not null check (kind in ('teacher', 'student')),
  alias text not null,
  canonical text not null,
  created_by text,
  created_at timestamptz not null default now(),
  primary key (kind, alias)
);

alter table public.feedback_name_aliases enable row level security;
revoke all on public.feedback_name_aliases from anon;
grant select, insert, update, delete on public.feedback_name_aliases to authenticated;
drop policy if exists feedback_name_aliases_admin_all on public.feedback_name_aliases;
create policy feedback_name_aliases_admin_all
  on public.feedback_name_aliases for all to authenticated
  using ((select public.is_feedback_admin()))
  with check ((select public.is_feedback_admin()));

insert into public.feedback_name_aliases (kind, alias, canonical, created_by) values
  ('teacher', 'Valentina 林', 'Valentina Lin', 'seed'),
  ('teacher', '马老师', '马怡婷', 'seed')
on conflict (kind, alias) do nothing;

-- 答卷表记下原始姓名和身份，"对不上的答卷"列表要靠这些字段显示给教务。
-- bound_by = manual 的行在重新同步时保留绑定，不被姓名匹配覆盖。
alter table public.feedback_responses
  add column if not exists student_name text,
  add column if not exists teacher_name text,
  add column if not exists identity text,
  add column if not exists bound_by text check (bound_by in ('name', 'manual'));

commit;
