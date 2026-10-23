begin;

-- 后台超级管理员（在后台里增删）；环境变量 ADMIN_OPEN_IDS 里的是创建者，不在这张表里
create table if not exists public.classroom_admins (
  "openId" text primary key,
  name text not null,
  "addedBy" text not null,
  "addedAt" bigint not null
);
alter table public.classroom_admins enable row level security;
revoke all on public.classroom_admins from anon, authenticated;

-- 老师在网页上改报告：第一次改之前留一份 AI 原稿
alter table public.classroom_lessons add column if not exists "rawReport" jsonb;

-- 表头筛选候选加上老师 open_id，老师登录只列自己的学生（新列只能加在末尾）
create or replace view public.classroom_lesson_people as
  select distinct "teacherName", student, "teacherOpenId" from public.classroom_lessons;
revoke all on public.classroom_lesson_people from anon, authenticated;

commit;
